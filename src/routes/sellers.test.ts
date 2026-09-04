import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Express } from "express";
import { createDb, type Db } from "../db/client";
import { discogsQueueJobs, releases, sellerInventory, sellers } from "../db/schema";
import { DiscogsQueue } from "../queue/discogs-queue";
import { checkRunCompletion } from "../indexing/run-completion";
import { createApp } from "../app";

describe("sellers routes", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;
  let app: Express;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    queue = new DiscogsQueue(db);
    queue.onSettled((job) => checkRunCompletion(db, job.runId));
    app = createApp({ db, queue });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    queue.stop();
    vi.useRealTimers();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  describe("POST /sellers/:username/index", () => {
    it("returns 202 with a runId and enqueues the first inventory_page job", async () => {
      const res = await request(app).post("/sellers/some-seller/index").send();

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ username: "some-seller", runId: expect.any(String) });

      const [seller] = db.select().from(sellers).where(eq(sellers.username, "some-seller")).all();
      expect(seller!.lastIndexStatus).toBe("running");
      expect(seller!.currentRunId).toBe(res.body.runId);

      const jobs = db.select().from(discogsQueueJobs).all();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.type).toBe("inventory_page");
      expect(jobs[0]!.runId).toBe(res.body.runId);
      expect(jobs[0]!.payload).toEqual({
        username: "some-seller",
        page: 1,
        runStartedAt: "2026-01-01T00:00:00.000Z",
      });
    });

    it("returns 409 if indexing is already running for that username", async () => {
      const first = await request(app).post("/sellers/some-seller/index").send();
      expect(first.status).toBe(202);

      const second = await request(app).post("/sellers/some-seller/index").send();
      expect(second.status).toBe(409);
    });

    it("allows re-indexing once the previous run has finished", async () => {
      const first = await request(app).post("/sellers/some-seller/index").send();
      expect(first.status).toBe(202);

      db.update(sellers)
        .set({ lastIndexStatus: "success" })
        .where(eq(sellers.username, "some-seller"))
        .run();

      const second = await request(app).post("/sellers/some-seller/index").send();
      expect(second.status).toBe(202);
    });
  });

  describe("GET /sellers/:username", () => {
    it("returns 404 for a username that has never been indexed", async () => {
      const res = await request(app).get("/sellers/unknown-seller");
      expect(res.status).toBe(404);
    });

    it("reflects live release_detail job counts for the current run as they change", async () => {
      const started = await request(app).post("/sellers/some-seller/index").send();
      const { runId } = started.body as { runId: string };

      const now = new Date();
      const insertJob = (releaseId: number) =>
        db
          .insert(discogsQueueJobs)
          .values({
            runId,
            type: "release_detail",
            payload: { releaseId },
            status: "pending",
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .all()[0]!;

      const jobA = insertJob(1);
      const jobB = insertJob(2);

      let res = await request(app).get("/sellers/some-seller");
      expect(res.body).toMatchObject({
        currentlyRunning: true,
        totalReleasesFound: 2,
        releasesEnriched: 0,
        releasesFailed: 0,
      });

      db.update(discogsQueueJobs).set({ status: "done" }).where(eq(discogsQueueJobs.id, jobA.id)).run();
      db.update(discogsQueueJobs).set({ status: "failed" }).where(eq(discogsQueueJobs.id, jobB.id)).run();

      res = await request(app).get("/sellers/some-seller");
      expect(res.body).toMatchObject({
        currentlyRunning: true,
        totalReleasesFound: 2,
        releasesEnriched: 1,
        releasesFailed: 1,
      });
    });

    it("flips to success (currentlyRunning: false) once the whole run settles, end to end", async () => {
      queue.registerHandler("inventory_page", vi.fn(async () => {}));
      queue.registerHandler("release_detail", vi.fn(async () => {}));

      await request(app).post("/sellers/some-seller/index").send();

      queue.start();
      await vi.advanceTimersByTimeAsync(0);

      const res = await request(app).get("/sellers/some-seller");
      expect(res.body).toMatchObject({
        lastIndexStatus: "success",
        currentlyRunning: false,
      });
      expect(res.body.lastIndexedAt).not.toBeNull();
    });
  });

  describe("GET /sellers/:username/inventory", () => {
    function seedRelease(id: number, title: string) {
      db.insert(releases)
        .values({
          id,
          title,
          year: 2000,
          country: null,
          genres: [],
          styles: [],
          formats: [],
          labelIds: [],
          artists: [],
        })
        .run();
    }

    function seedInventoryRow(releaseId: number, status: "active" | "sold") {
      const now = new Date();
      db.insert(sellerInventory)
        .values({
          sellerUsername: "some-seller",
          releaseId,
          status,
          firstSeenAt: now,
          lastSeenAt: now,
          soldAt: status === "sold" ? now : null,
        })
        .run();
    }

    it("excludes rows whose release hasn't been enriched yet", async () => {
      // seller_inventory row exists (release 1 discovered), but no releases row yet
      db.insert(sellerInventory)
        .values({
          sellerUsername: "some-seller",
          releaseId: 1,
          status: "active",
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
          soldAt: null,
        })
        .run();

      const res = await request(app).get("/sellers/some-seller/inventory");
      expect(res.body.items).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    it("defaults to status=active and excludes sold listings", async () => {
      seedRelease(1, "Active Release");
      seedRelease(2, "Sold Release");
      seedInventoryRow(1, "active");
      seedInventoryRow(2, "sold");

      const res = await request(app).get("/sellers/some-seller/inventory");
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({ releaseId: 1, title: "Active Release", status: "active" });
      expect(res.body.total).toBe(1);
    });

    it("returns sold listings when status=sold, and both when status=all", async () => {
      seedRelease(1, "Active Release");
      seedRelease(2, "Sold Release");
      seedInventoryRow(1, "active");
      seedInventoryRow(2, "sold");

      const soldRes = await request(app).get("/sellers/some-seller/inventory?status=sold");
      expect(soldRes.body.items).toHaveLength(1);
      expect(soldRes.body.items[0]).toMatchObject({ releaseId: 2, status: "sold" });

      const allRes = await request(app).get("/sellers/some-seller/inventory?status=all");
      expect(allRes.body.items).toHaveLength(2);
      expect(allRes.body.total).toBe(2);
    });

    it("paginates with page/pageSize", async () => {
      seedRelease(1, "R1");
      seedRelease(2, "R2");
      seedRelease(3, "R3");
      seedInventoryRow(1, "active");
      seedInventoryRow(2, "active");
      seedInventoryRow(3, "active");

      const res = await request(app).get("/sellers/some-seller/inventory?page=2&pageSize=2");
      expect(res.body.items).toHaveLength(1);
      expect(res.body).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    });
  });
});
