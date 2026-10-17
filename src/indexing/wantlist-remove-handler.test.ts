import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "../db/client";
import { collectionItems, discogsProfiles, discogsTokens, hiddenReleases, wantlistItems } from "../db/schema";
import { DiscogsAuthError } from "../discogs-client";
import { NonRetryableError } from "../queue/discogs-queue";
import { createWantlistRemoveHandler } from "./wantlist-remove-handler";

describe("wantlist_remove handler", () => {
  let dbPath: string;
  let db: Db;
  const deleteWantlistItem = vi.fn<(username: string, releaseId: number, token: string) => Promise<void>>();
  const context = { runId: "r", jobId: 1 };

  const handler = (token: string | null = "tok") =>
    createWantlistRemoveHandler({ db, getToken: () => token, deleteWantlistItem });

  const want = (uid: string, releaseId: number) =>
    db.insert(wantlistItems).values({ uid, releaseId, masterId: null, title: "T", artists: [], addedAt: null }).run();
  const hide = (uid: string, releaseId: number) => db.insert(hiddenReleases).values({ uid, releaseId }).run();
  const hiddenIds = (uid: string) =>
    db.select().from(hiddenReleases).all().filter((row) => row.uid === uid).map((row) => row.releaseId);
  const wantedIds = (uid: string) =>
    db.select().from(wantlistItems).all().filter((row) => row.uid === uid).map((row) => row.releaseId);

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    db.insert(discogsTokens).values({ uid: "u1", tokenEncrypted: "x", username: "dan", createdAt: new Date() }).run();
    db.insert(discogsProfiles)
      .values({ uid: "u1", username: "dan", collectionCount: 5, wantlistCount: 2, fetchedAt: new Date() })
      .run();
    want("u1", 1);
    want("u1", 2);
    want("u2", 1);
    hide("u1", 1);
    hide("u1", 2);
    hide("u2", 1);
    deleteWantlistItem.mockReset().mockResolvedValue();
  });

  afterEach(() => {
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  it("removes the release from Discogs, the mirror and the hidden releases, for that collector only", async () => {
    await handler()({ uid: "u1", releaseId: 1 }, context);

    expect(deleteWantlistItem).toHaveBeenCalledWith("dan", 1, "tok");
    expect(wantedIds("u1")).toEqual([2]);
    expect(hiddenIds("u1")).toEqual([2]);
    expect(wantedIds("u2")).toEqual([1]);
    expect(hiddenIds("u2")).toEqual([1]);
    expect(db.select().from(discogsProfiles).get()!.wantlistCount).toBe(1);
  });

  it("keeps the release hidden while it is in the collection", async () => {
    db.insert(collectionItems).values({ uid: "u1", releaseId: 1, masterId: null, title: "T", artists: [] }).run();

    await handler()({ uid: "u1", releaseId: 1 }, context);

    expect(wantedIds("u1")).toEqual([2]);
    expect(hiddenIds("u1").sort()).toEqual([1, 2]);
  });

  it("changes nothing locally when Discogs refuses", async () => {
    deleteWantlistItem.mockRejectedValue(new DiscogsAuthError("no"));

    await expect(handler()({ uid: "u1", releaseId: 1 }, context)).rejects.toBeInstanceOf(DiscogsAuthError);

    expect(wantedIds("u1")).toEqual([1, 2]);
    expect(hiddenIds("u1")).toEqual([1, 2]);
  });

  it("fails without a token", async () => {
    await expect(handler(null)({ uid: "u1", releaseId: 1 }, context)).rejects.toBeInstanceOf(NonRetryableError);
    expect(deleteWantlistItem).not.toHaveBeenCalled();
  });
});
