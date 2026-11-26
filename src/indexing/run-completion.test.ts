import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "../db/client";
import { discogsQueueJobs, scanListings, sellerInventory, sellers } from "../db/schema";
import { checkRunCompletion, failOrphanedRuns, markRunAborted } from "./run-completion";

const RUN_START = new Date("2026-01-01T00:00:00.000Z");

describe("checkRunCompletion", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  /** A seller whose run `run-1` has scanned (`scanCompletedAt` set) unless told otherwise. */
  function seedSeller(
    status: "running" | "success" | "error" | "never",
    extra: Partial<typeof sellers.$inferInsert> = {},
  ) {
    db.insert(sellers)
      .values({
        username: "some-seller",
        lastIndexStatus: status,
        currentRunId: "run-1",
        lastIndexedAt: null,
        scanCompletedAt: RUN_START,
        ...extra,
      })
      .run();
  }

  function seedJob(runId: string, type: "inventory_page" | "release_detail", status: string, payload: unknown) {
    const now = new Date();
    db.insert(discogsQueueJobs)
      .values({
        uid: "u1",
        runId,
        type,
        payload: payload as never,
        status: status as never,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  const page1 = { uid: "u1", username: "some-seller", page: 1, runStartedAt: RUN_START.toISOString() };
  const statusOf = (username = "some-seller") =>
    db.select().from(sellers).where(eq(sellers.username, username)).all()[0]!.lastIndexStatus;

  it("flips a running seller to success once every job for the run is done", () => {
    seedSeller("running");
    seedJob("run-1", "inventory_page", "done", page1);
    seedJob("run-1", "release_detail", "done", { uid: "u1", releaseId: 1 });

    checkRunCompletion(db, "run-1");

    const [row] = db.select().from(sellers).where(eq(sellers.username, "some-seller")).all();
    expect(row!.lastIndexStatus).toBe("success");
    expect(row!.lastIndexedAt).toEqual(new Date("2026-01-02T00:00:00.000Z"));
  });

  it("does nothing while a job for the run is still pending or processing", () => {
    seedSeller("running");
    seedJob("run-1", "inventory_page", "done", page1);
    seedJob("run-1", "release_detail", "pending", { uid: "u1", releaseId: 1 });

    checkRunCompletion(db, "run-1");

    expect(statusOf()).toBe("running");
  });

  it("still flips to success when some release_detail jobs failed (partial failure is tolerated)", () => {
    seedSeller("running");
    seedJob("run-1", "inventory_page", "done", page1);
    seedJob("run-1", "release_detail", "done", { uid: "u1", releaseId: 1 });
    seedJob("run-1", "release_detail", "failed", { uid: "u1", releaseId: 2 });

    checkRunCompletion(db, "run-1");

    expect(statusOf()).toBe("success");
  });

  it("ends in error when a scan page failed for good, so the scan never finished", () => {
    seedSeller("running", { scanCompletedAt: null });
    seedJob("run-1", "inventory_page", "failed", page1);

    checkRunCompletion(db, "run-1");

    expect(statusOf()).toBe("error");
  });

  it("does not clobber a seller that is no longer running (stale/duplicate check)", () => {
    seedSeller("error");
    seedJob("run-1", "inventory_page", "done", page1);

    checkRunCompletion(db, "run-1");

    expect(statusOf()).toBe("error");
  });

  it("ignores a run that belongs to no seller, such as an enrichment run", () => {
    seedSeller("running");
    seedJob("enrichment-run", "release_detail", "done", { uid: "u1", releaseId: 1 });

    checkRunCompletion(db, "enrichment-run");

    expect(statusOf()).toBe("running");
  });

  it("markRunAborted flips the run's seller to error", () => {
    seedSeller("running");
    seedJob("run-1", "inventory_page", "done", page1);

    markRunAborted(db, "run-1");

    expect(statusOf()).toBe("error");
  });

  describe("items no longer for sale", () => {
    function seedRun(inventoryTotal: number, listingsRead: number[]) {
      seedSeller("running", { inventoryTotal });
      seedJob("run-1", "inventory_page", "done", page1);
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
      const item = (releaseId: number, lastSeenAt: Date) => ({
        sellerUsername: "some-seller",
        releaseId,
        status: "active" as const,
        firstSeenAt: new Date("2025-11-01T00:00:00.000Z"),
        lastSeenAt,
      });
      db.insert(sellerInventory)
        .values([item(1, RUN_START), item(2, new Date("2025-12-01T00:00:00.000Z"))])
        .run();
    }

    const statuses = () =>
      db
        .select({ releaseId: sellerInventory.releaseId, status: sellerInventory.status, soldAt: sellerInventory.soldAt })
        .from(sellerInventory)
        .orderBy(sellerInventory.releaseId)
        .all();

    it("marks as sold what a run that read the whole inventory did not see", () => {
      seedRun(1, [10]);

      checkRunCompletion(db, "run-1");

      expect(statuses()).toEqual([
        { releaseId: 1, status: "active", soldAt: null },
        { releaseId: 2, status: "sold", soldAt: RUN_START },
      ]);
    });

    it("keeps them active when the run fell short of the inventory, since they may just be out of reach", () => {
      seedRun(2, [10]);

      checkRunCompletion(db, "run-1");

      expect(statuses().map((row) => row.status)).toEqual(["active", "active"]);
    });
  });

  describe("failOrphanedRuns", () => {
    function seedRunning(username: string, runId: string | null) {
      db.insert(sellers)
        .values({ username, lastIndexStatus: "running", currentRunId: runId, lastIndexedAt: null })
        .run();
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
      seedJob("run-1", "release_detail", "pending", { uid: "u1", releaseId: 1 });
      seedJob("run-2", "release_detail", "processing", { uid: "u1", releaseId: 2 });

      expect(failOrphanedRuns(db)).toBe(0);
      expect(statusOf("busy")).toBe("running");
      expect(statusOf("busy-too")).toBe("running");
    });

    it("leaves sellers that are not running alone", () => {
      seedRunning("done", "run-9");
      db.update(sellers).set({ lastIndexStatus: "success" }).where(eq(sellers.username, "done")).run();

      expect(failOrphanedRuns(db)).toBe(0);
      expect(statusOf("done")).toBe("success");
    });
  });
});
