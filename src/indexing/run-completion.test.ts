import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "../db/client";
import { discogsQueueJobs, sellers } from "../db/schema";
import { checkRunCompletion } from "./run-completion";

describe("checkRunCompletion", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  function seedSeller(username: string, status: "running" | "success" | "error" | "never") {
    db.insert(sellers).values({ username, lastIndexStatus: status, lastIndexedAt: null }).run();
  }

  function seedJob(runId: string, type: "inventory_page" | "release_detail", status: string, payload: unknown) {
    const now = new Date();
    db.insert(discogsQueueJobs)
      .values({ runId, type, payload: payload as never, status: status as never, createdAt: now, updatedAt: now })
      .run();
  }

  it("flips a running seller to success once every job for the run is done", () => {
    seedSeller("some-seller", "running");
    seedJob("run-1", "inventory_page", "done", { username: "some-seller", page: 1, runStartedAt: "2026-01-01T00:00:00.000Z" });
    seedJob("run-1", "release_detail", "done", { releaseId: 1 });

    checkRunCompletion(db, "run-1");

    const [row] = db.select().from(sellers).where(eq(sellers.username, "some-seller")).all();
    expect(row!.lastIndexStatus).toBe("success");
    expect(row!.lastIndexedAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("does nothing while a job for the run is still pending or processing", () => {
    seedSeller("some-seller", "running");
    seedJob("run-1", "inventory_page", "done", { username: "some-seller", page: 1, runStartedAt: "2026-01-01T00:00:00.000Z" });
    seedJob("run-1", "release_detail", "pending", { releaseId: 1 });

    checkRunCompletion(db, "run-1");

    const [row] = db.select().from(sellers).where(eq(sellers.username, "some-seller")).all();
    expect(row!.lastIndexStatus).toBe("running");
  });

  it("still flips to success when some release_detail jobs failed (partial failure is tolerated)", () => {
    seedSeller("some-seller", "running");
    seedJob("run-1", "inventory_page", "done", { username: "some-seller", page: 1, runStartedAt: "2026-01-01T00:00:00.000Z" });
    seedJob("run-1", "release_detail", "done", { releaseId: 1 });
    seedJob("run-1", "release_detail", "failed", { releaseId: 2 });

    checkRunCompletion(db, "run-1");

    const [row] = db.select().from(sellers).where(eq(sellers.username, "some-seller")).all();
    expect(row!.lastIndexStatus).toBe("success");
  });

  it("does not clobber a seller that is no longer running (stale/duplicate check)", () => {
    seedSeller("some-seller", "error");
    seedJob("run-1", "inventory_page", "done", { username: "some-seller", page: 1, runStartedAt: "2026-01-01T00:00:00.000Z" });

    checkRunCompletion(db, "run-1");

    const [row] = db.select().from(sellers).where(eq(sellers.username, "some-seller")).all();
    expect(row!.lastIndexStatus).toBe("error");
  });
});
