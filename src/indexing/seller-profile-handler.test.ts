import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "../db/client";
import { sellers } from "../db/schema";
import { DiscogsNotFoundError } from "../discogs-client";
import { NonRetryableError, SCAN_PRIORITY, type EnqueueInput } from "../queue/discogs-queue";
import { createSellerProfileHandler } from "./seller-profile-handler";

describe("seller_profile handler", () => {
  let dbPath: string;
  let db: Db;
  let enqueue: ReturnType<typeof vi.fn<(job: EnqueueInput) => number>>;
  const ctx = { runId: "run-1", jobId: 1 };

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    enqueue = vi.fn<(job: EnqueueInput) => number>().mockReturnValue(1);
  });

  afterEach(() => {
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  it("creates the seller under Discogs' casing and queues page 1 of the run", async () => {
    const handler = createSellerProfileHandler({
      db,
      enqueue,
      getToken: () => "token",
      getUserProfile: async () => ({ username: "FooBar" }),
    });

    await handler({ uid: "u1", username: "foobar" }, ctx);

    const [seller] = db.select().from(sellers).all();
    expect(seller).toMatchObject({ username: "FooBar", lastIndexStatus: "running", currentRunId: "run-1", runUid: "u1" });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        type: "inventory_page",
        priority: SCAN_PRIORITY,
        payload: expect.objectContaining({ uid: "u1", username: "FooBar", page: 1 }),
      }),
    );
  });

  it("creates nothing and does not retry when Discogs has no such user", async () => {
    const handler = createSellerProfileHandler({
      db,
      enqueue,
      getToken: () => "token",
      getUserProfile: async () => {
        throw new DiscogsNotFoundError("404");
      },
    });

    await expect(handler({ uid: "u1", username: "nobody" }, ctx)).rejects.toBeInstanceOf(NonRetryableError);

    expect(db.select().from(sellers).all()).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("leaves a seller that is already running alone", async () => {
    db.insert(sellers).values({ username: "FooBar", lastIndexStatus: "running", currentRunId: "other" }).run();
    const handler = createSellerProfileHandler({
      db,
      enqueue,
      getToken: () => "token",
      getUserProfile: async () => ({ username: "FooBar" }),
    });

    await handler({ uid: "u1", username: "foobar" }, ctx);

    const [seller] = db.select().from(sellers).where(eq(sellers.username, "FooBar")).all();
    expect(seller!.currentRunId).toBe("other");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("fails without asking Discogs when the collector has no token", async () => {
    const getUserProfile = vi.fn(async () => ({ username: "FooBar" }));
    const handler = createSellerProfileHandler({ db, enqueue, getToken: () => null, getUserProfile });

    await expect(handler({ uid: "u1", username: "foobar" }, ctx)).rejects.toBeInstanceOf(NonRetryableError);

    expect(getUserProfile).not.toHaveBeenCalled();
    expect(db.select().from(sellers).all()).toEqual([]);
  });
});
