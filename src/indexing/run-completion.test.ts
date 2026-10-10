import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "../db/client";
import { discogsQueueJobs, scanListings, sellerListings, sellers } from "../db/schema";
import { checkRunCompletion, failOrphanedRuns, markRunAborted } from "./run-completion";

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

  describe("listings no longer for sale", () => {
    const runStart = new Date("2026-01-01T00:00:00.000Z");

    function seedRun(inventoryTotal: number, listingsRead: number[]) {
      db.insert(sellers)
        .values({ username: "some-seller", lastIndexStatus: "running", currentRunId: "run-1", inventoryTotal })
        .run();
      seedJob("run-1", "inventory_page", "done", {
        username: "some-seller",
        page: 1,
        runStartedAt: runStart.toISOString(),
      });
      db.insert(scanListings)
        .values(
          listingsRead.map((listingId) => ({
            runId: "run-1",
            sellerUsername: "some-seller",
            sort: "artist" as const,
            order: "asc" as const,
            listingId,
          })),
        )
        .run();
      const seen = (listingId: number, lastSeenAt: Date) => ({
        listingId,
        sellerUsername: "some-seller",
        releaseId: 5,
        mediaCondition: "Mint (M)",
        sleeveCondition: null,
        price: 10,
        currency: "USD",
        lastSeenAt,
      });
      db.insert(sellerListings)
        .values([seen(1, runStart), seen(2, new Date("2025-12-01T00:00:00.000Z"))])
        .run();
    }

    const storedIds = () => db.select().from(sellerListings).all().map((l) => l.listingId);

    it("deletes the listings a run that read the whole inventory did not see", () => {
      seedRun(1, [1]);

      checkRunCompletion(db, "run-1");

      expect(storedIds()).toEqual([1]);
    });

    it("keeps them when the run fell short of the inventory, since they may just be out of reach", () => {
      seedRun(2, [1]);

      checkRunCompletion(db, "run-1");

      expect(storedIds()).toEqual([1, 2]);
    });
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

  it("markRunAborted flips the run's seller to error, even after the run-completion check marked it success", () => {
    db.insert(sellers)
      .values({ username: "some-seller", lastIndexStatus: "running", currentRunId: "run-1", lastIndexedAt: null })
      .run();
    seedJob("run-1", "inventory_page", "done", { username: "some-seller", page: 1, runStartedAt: "2026-01-01T00:00:00.000Z" });
    checkRunCompletion(db, "run-1");

    markRunAborted(db, "run-1");

    const [row] = db.select().from(sellers).where(eq(sellers.username, "some-seller")).all();
    expect(row!.lastIndexStatus).toBe("error");
  });

  describe("failOrphanedRuns", () => {
    function seedRunning(username: string, runId: string | null) {
      db.insert(sellers)
        .values({ username, lastIndexStatus: "running", currentRunId: runId, lastIndexedAt: null })
        .run();
    }

    function statusOf(username: string) {
      return db.select().from(sellers).where(eq(sellers.username, username)).all()[0]!.lastIndexStatus;
    }

    it("flips a running seller with no job for its run to error", () => {
      seedRunning("stuck", "run-1");

      expect(failOrphanedRuns(db)).toBe(1);
      expect(statusOf("stuck")).toBe("error");
    });

    it("flips a running seller that has no run id", () => {
      seedRunning("stuck", null);

      expect(failOrphanedRuns(db)).toBe(1);
      expect(statusOf("stuck")).toBe("error");
    });

    it("leaves a running seller alone while a job for its run is pending or processing", () => {
      seedRunning("busy", "run-1");
      seedRunning("busy-too", "run-2");
      seedJob("run-1", "release_detail", "pending", { releaseId: 1 });
      seedJob("run-2", "release_detail", "processing", { releaseId: 2 });

      expect(failOrphanedRuns(db)).toBe(0);
      expect(statusOf("busy")).toBe("running");
      expect(statusOf("busy-too")).toBe("running");
    });

    it("leaves sellers that are not running alone", () => {
      seedSeller("done", "success");

      expect(failOrphanedRuns(db)).toBe(0);
      expect(statusOf("done")).toBe("success");
    });
  });
});
