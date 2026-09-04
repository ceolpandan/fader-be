import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "./client";
import { discogsQueueJobs } from "./schema";

describe("discogs_queue_jobs table", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
  });

  afterEach(() => {
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  it("persists a job with defaulted attempts/status and an auto-generated id", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");

    const [inserted] = db
      .insert(discogsQueueJobs)
      .values({
        runId: "run-1",
        type: "inventory_page",
        payload: { username: "some-seller", page: 1, runStartedAt: now.toISOString() },
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all();

    expect(inserted).toBeDefined();
    expect(inserted!.id).toEqual(expect.any(Number));
    expect(inserted!.status).toBe("pending");
    expect(inserted!.attempts).toBe(0);
    expect(inserted!.errorMessage).toBeNull();

    const [result] = db
      .select()
      .from(discogsQueueJobs)
      .where(eq(discogsQueueJobs.id, inserted!.id))
      .all();

    expect(result).toEqual({
      id: inserted!.id,
      runId: "run-1",
      type: "inventory_page",
      payload: { username: "some-seller", page: 1, runStartedAt: now.toISOString() },
      status: "pending",
      attempts: 0,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    });
  });
});
