import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "../db/client";
import { fades, masterVersions, type FadeKind } from "../db/schema";
import { DiscogsNotFoundError, DiscogsTransientError } from "../discogs-client";
import { INLINE_PRIORITY, NonRetryableError, type EnqueueInput } from "../queue/discogs-queue";
import type { DiscogsRelease } from "../types/discogs-api";
import { createFadeLookupHandler, markFadeLookupFailed } from "./fade-lookup-handler";

describe("fade_lookup handler", () => {
  let dbPath: string;
  let db: Db;
  let enqueue: ReturnType<typeof vi.fn<(job: EnqueueInput) => number>>;
  const getRelease = vi.fn<(id: number) => Promise<DiscogsRelease>>();
  const getVersions = vi.fn<(id: number) => Promise<number[]>>();
  const ctx = { runId: "fade:u1:1", jobId: 1 };

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    enqueue = vi.fn<(job: EnqueueInput) => number>().mockReturnValue(1);
    getRelease.mockReset();
    getVersions.mockReset();
  });

  afterEach(() => {
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  const handler = () =>
    createFadeLookupHandler({ db, enqueue, getRelease, getMasterVersionReleaseIds: getVersions });
  const fade = (uid: string, kind: FadeKind, id: number) =>
    db.insert(fades).values({ uid, kind, id, createdAt: new Date(1000), lookupStatus: "pending" }).run();
  const fadeRows = () => db.select().from(fades).all();
  const release = (masterId?: number) => ({ id: 1, master_id: masterId }) as DiscogsRelease;

  it("upgrades a release fade to its master and queues the master's lookup", async () => {
    fade("u1", "release", 1);
    getRelease.mockResolvedValue(release(900));

    await handler()({ uid: "u1", kind: "release", id: 1 }, ctx);

    expect(fadeRows()).toEqual([
      { uid: "u1", kind: "master", id: 900, createdAt: new Date(1000), lookupStatus: "pending" },
    ]);
    expect(enqueue).toHaveBeenCalledWith({
      runId: "fade:u1:900",
      type: "fade_lookup",
      payload: { uid: "u1", kind: "master", id: 900 },
      priority: INLINE_PRIORITY,
    });
  });

  it("merges into the collector's existing fade of that master", async () => {
    fade("u1", "release", 1);
    db.insert(fades).values({ uid: "u1", kind: "master", id: 900, createdAt: new Date(5), lookupStatus: "done" }).run();
    getRelease.mockResolvedValue(release(900));

    await handler()({ uid: "u1", kind: "release", id: 1 }, ctx);

    expect(fadeRows()).toMatchObject([{ kind: "master", id: 900, lookupStatus: "done" }]);
  });

  it("keeps a release without a master as it is and marks it done", async () => {
    fade("u1", "release", 1);
    getRelease.mockResolvedValue(release());

    await handler()({ uid: "u1", kind: "release", id: 1 }, ctx);

    expect(fadeRows()).toMatchObject([{ kind: "release", id: 1, lookupStatus: "done" }]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("stores a master's versions and resolves every collector's pending fade of it", async () => {
    fade("u1", "master", 900);
    fade("u2", "master", 900);
    getVersions.mockResolvedValue([11, 12, 12]);

    await handler()({ uid: "u1", kind: "master", id: 900 }, ctx);

    expect(db.select().from(masterVersions).all()).toHaveLength(2);
    expect(fadeRows().map((row) => row.lookupStatus)).toEqual(["done", "done"]);
  });

  it("does not refetch versions that are already stored", async () => {
    fade("u1", "master", 900);
    db.insert(masterVersions).values({ masterId: 900, releaseId: 11 }).run();

    await handler()({ uid: "u1", kind: "master", id: 900 }, ctx);

    expect(getVersions).not.toHaveBeenCalled();
    expect(fadeRows()).toMatchObject([{ lookupStatus: "done" }]);
  });

  it("does nothing when the fade was removed while the lookup waited", async () => {
    await handler()({ uid: "u1", kind: "master", id: 900 }, ctx);

    expect(getVersions).not.toHaveBeenCalled();
    expect(db.select().from(masterVersions).all()).toEqual([]);
  });

  it("fails permanently when Discogs doesn't know the release or master", async () => {
    fade("u1", "release", 1);
    fade("u1", "master", 900);
    getRelease.mockRejectedValue(new DiscogsNotFoundError("nope"));
    getVersions.mockRejectedValue(new DiscogsNotFoundError("nope"));

    await expect(handler()({ uid: "u1", kind: "release", id: 1 }, ctx)).rejects.toBeInstanceOf(NonRetryableError);
    await expect(handler()({ uid: "u1", kind: "master", id: 900 }, ctx)).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("lets transient Discogs errors through for the queue to retry", async () => {
    fade("u1", "master", 900);
    getVersions.mockRejectedValue(new DiscogsTransientError("down"));

    await expect(handler()({ uid: "u1", kind: "master", id: 900 }, ctx)).rejects.toBeInstanceOf(
      DiscogsTransientError,
    );
    expect(fadeRows()).toMatchObject([{ lookupStatus: "pending" }]);
  });

  describe("markFadeLookupFailed", () => {
    const job = (status: "failed" | "done") => ({
      type: "fade_lookup",
      status,
      payload: { uid: "u1", kind: "release", id: 1 },
    });

    it("marks the fade failed and keeps it", () => {
      fade("u1", "release", 1);
      markFadeLookupFailed(db, job("failed"));

      expect(fadeRows()).toMatchObject([{ kind: "release", id: 1, lookupStatus: "failed" }]);
    });

    it("ignores jobs that succeeded or are of another type", () => {
      fade("u1", "release", 1);
      markFadeLookupFailed(db, job("done"));
      markFadeLookupFailed(db, { ...job("failed"), type: "release_detail" });

      expect(
        db
          .select()
          .from(fades)
          .where(and(eq(fades.uid, "u1"), eq(fades.lookupStatus, "pending")))
          .all(),
      ).toHaveLength(1);
    });
  });
});
