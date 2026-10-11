import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "../db/client";
import { discogsProfiles, discogsTokens } from "../db/schema";
import { DiscogsAuthError } from "../discogs-client";
import { NonRetryableError, PACING_MS } from "../queue/discogs-queue";
import { createDiscogsProfileHandler } from "./discogs-profile-handler";

describe("discogs_profile handler", () => {
  let dbPath: string;
  let db: Db;
  const getCollectionCount = vi.fn<(username: string, token: string) => Promise<number>>();
  const getWantlistCount = vi.fn<(username: string, token: string) => Promise<number>>();
  const sleep = vi.fn(async () => {});
  const context = { runId: "r", jobId: 1 };

  const handler = (token: string | null = "tok") =>
    createDiscogsProfileHandler({ db, getToken: () => token, getCollectionCount, getWantlistCount, sleep });

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    db.insert(discogsTokens).values({ uid: "u1", tokenEncrypted: "x", username: "dan", createdAt: new Date() }).run();
    getCollectionCount.mockReset().mockResolvedValue(120);
    getWantlistCount.mockReset().mockResolvedValue(7);
    sleep.mockClear();
  });

  afterEach(() => {
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  it("caches the counts of the username saved with the token, spacing the two requests", async () => {
    await handler()({ uid: "u1" }, context);

    expect(getCollectionCount).toHaveBeenCalledWith("dan", "tok");
    expect(getWantlistCount).toHaveBeenCalledWith("dan", "tok");
    expect(sleep).toHaveBeenCalledWith(PACING_MS);
    const row = db.select().from(discogsProfiles).get()!;
    expect(row).toMatchObject({ uid: "u1", username: "dan", collectionCount: 120, wantlistCount: 7 });
  });

  it("replaces an earlier cache", async () => {
    await handler()({ uid: "u1" }, context);
    getCollectionCount.mockResolvedValue(121);

    await handler()({ uid: "u1" }, context);

    const rows = db.select().from(discogsProfiles).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.collectionCount).toBe(121);
  });

  it("caches nothing when the second request fails", async () => {
    getWantlistCount.mockRejectedValue(new DiscogsAuthError("revoked"));

    await expect(handler()({ uid: "u1" }, context)).rejects.toThrow(DiscogsAuthError);

    expect(db.select().from(discogsProfiles).all()).toEqual([]);
  });

  it("fails for good without a token, without asking Discogs", async () => {
    await expect(handler(null)({ uid: "u1" }, context)).rejects.toThrow(NonRetryableError);
    await expect(handler()({ uid: "nobody" }, context)).rejects.toThrow(NonRetryableError);

    expect(getCollectionCount).not.toHaveBeenCalled();
  });
});
