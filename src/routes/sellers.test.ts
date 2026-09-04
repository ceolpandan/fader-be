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

  describe("GET /sellers", () => {
    it("lists every seller that has ever been indexed", async () => {
      await request(app).post("/sellers/seller-a/index").send();
      await request(app).post("/sellers/seller-b/index").send();
      db.update(sellers).set({ lastIndexStatus: "success" }).where(eq(sellers.username, "seller-a")).run();

      const res = await request(app).get("/sellers");
      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ username: "seller-a", lastIndexStatus: "success" }),
          expect.objectContaining({ username: "seller-b", lastIndexStatus: "running" }),
        ]),
      );
      expect(res.body).toHaveLength(2);
    });

    it("returns an empty array when no seller has ever been indexed", async () => {
      const res = await request(app).get("/sellers");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("GET /sellers/:username/inventory", () => {
    function seedRelease(
      id: number,
      title: string,
      overrides: Partial<{
        year: number | null;
        country: string | null;
        genres: string[];
        styles: string[];
        formats: { name: string; descriptions: string[] }[];
        artists: { id: number; name: string }[];
      }> = {},
    ) {
      db.insert(releases)
        .values({
          id,
          title,
          year: overrides.year ?? 2000,
          country: overrides.country ?? null,
          genres: overrides.genres ?? [],
          styles: overrides.styles ?? [],
          formats: overrides.formats ?? [],
          labelIds: [],
          artists: overrides.artists ?? [],
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

    it("always excludes sold listings and returns only active ones", async () => {
      seedRelease(1, "Active Release");
      seedRelease(2, "Sold Release");
      seedInventoryRow(1, "active");
      seedInventoryRow(2, "sold");

      const res = await request(app).get("/sellers/some-seller/inventory");
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({ releaseId: 1, title: "Active Release", status: "active" });
      expect(res.body.total).toBe(1);
    });

    it("ignores a status query param — sold listings never come back", async () => {
      seedRelease(1, "Active Release");
      seedRelease(2, "Sold Release");
      seedInventoryRow(1, "active");
      seedInventoryRow(2, "sold");

      const res = await request(app).get("/sellers/some-seller/inventory?status=all");
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({ releaseId: 1, status: "active" });
      expect(res.body.total).toBe(1);
    });

    it("filters by country (OR-matched, comma-separated)", async () => {
      seedRelease(1, "UK Release", { country: "UK" });
      seedRelease(2, "US Release", { country: "US" });
      seedRelease(3, "German Release", { country: "Germany" });
      seedInventoryRow(1, "active");
      seedInventoryRow(2, "active");
      seedInventoryRow(3, "active");

      const res = await request(app).get("/sellers/some-seller/inventory?country=UK,US");
      expect(res.body.items.map((i: { releaseId: number }) => i.releaseId).sort()).toEqual([1, 2]);
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

    it("returns the extended release columns on each item", async () => {
      seedRelease(1, "Full Release", {
        genres: ["Rock"],
        styles: ["Prog Rock"],
        formats: [{ name: "Vinyl", descriptions: ["LP", "Album"] }],
        artists: [{ id: 99, name: "Some Artist" }],
      });
      seedInventoryRow(1, "active");

      const res = await request(app).get("/sellers/some-seller/inventory");
      expect(res.body.items[0]).toMatchObject({
        genres: ["Rock"],
        styles: ["Prog Rock"],
        formats: [{ name: "Vinyl", descriptions: ["LP", "Album"] }],
        artists: [{ id: 99, name: "Some Artist" }],
      });
    });

    it("filters by genre, style, and format (OR-matched, comma-separated)", async () => {
      seedRelease(1, "Rock LP", { genres: ["Rock"], formats: [{ name: "Vinyl", descriptions: [] }] });
      seedRelease(2, "Jazz CD", { genres: ["Jazz"], formats: [{ name: "CD", descriptions: [] }] });
      seedRelease(3, "Electronic Tape", { genres: ["Electronic"], formats: [{ name: "Cassette", descriptions: [] }] });
      seedInventoryRow(1, "active");
      seedInventoryRow(2, "active");
      seedInventoryRow(3, "active");

      const genreRes = await request(app).get("/sellers/some-seller/inventory?genre=Rock,Jazz");
      expect(genreRes.body.items.map((i: { releaseId: number }) => i.releaseId).sort()).toEqual([1, 2]);

      const formatRes = await request(app).get("/sellers/some-seller/inventory?format=Vinyl");
      expect(formatRes.body.items.map((i: { releaseId: number }) => i.releaseId)).toEqual([1]);
    });

    it("filters by yearMin/yearMax", async () => {
      seedRelease(1, "Old", { year: 1980 });
      seedRelease(2, "Mid", { year: 2000 });
      seedRelease(3, "New", { year: 2020 });
      seedInventoryRow(1, "active");
      seedInventoryRow(2, "active");
      seedInventoryRow(3, "active");

      const res = await request(app).get("/sellers/some-seller/inventory?yearMin=1990&yearMax=2010");
      expect(res.body.items.map((i: { releaseId: number }) => i.releaseId)).toEqual([2]);
    });

    it("rejects an invalid sort value with 400", async () => {
      const res = await request(app).get("/sellers/some-seller/inventory?sort=bogus");
      expect(res.status).toBe(400);
    });

    it("sorts by year descending and stays correct across pages", async () => {
      seedRelease(1, "A", { year: 1990 });
      seedRelease(2, "B", { year: 2010 });
      seedRelease(3, "C", { year: 2000 });
      seedInventoryRow(1, "active");
      seedInventoryRow(2, "active");
      seedInventoryRow(3, "active");

      const page1 = await request(app).get("/sellers/some-seller/inventory?sort=-year&page=1&pageSize=2");
      expect(page1.body.items.map((i: { year: number }) => i.year)).toEqual([2010, 2000]);

      const page2 = await request(app).get("/sellers/some-seller/inventory?sort=-year&page=2&pageSize=2");
      expect(page2.body.items.map((i: { year: number }) => i.year)).toEqual([1990]);
    });
  });

  describe("GET /sellers/:username/inventory/facets", () => {
    it("returns distinct genres, styles, format names, and countries across the seller's full inventory", async () => {
      db.insert(releases)
        .values([
          {
            id: 1,
            title: "R1",
            year: 2000,
            country: "UK",
            genres: ["Rock", "Pop"],
            styles: ["Prog Rock"],
            formats: [{ name: "Vinyl", descriptions: ["LP"] }],
            labelIds: [],
            artists: [],
          },
          {
            id: 2,
            title: "R2",
            year: 2001,
            country: "US",
            genres: ["Rock"],
            styles: ["Indie Rock"],
            formats: [{ name: "CD", descriptions: [] }],
            labelIds: [],
            artists: [],
          },
        ])
        .run();

      const now = new Date();
      db.insert(sellerInventory)
        .values([
          { sellerUsername: "some-seller", releaseId: 1, status: "active", firstSeenAt: now, lastSeenAt: now, soldAt: null },
          { sellerUsername: "some-seller", releaseId: 2, status: "sold", firstSeenAt: now, lastSeenAt: now, soldAt: now },
        ])
        .run();

      const res = await request(app).get("/sellers/some-seller/inventory/facets");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        genres: ["Pop", "Rock"],
        styles: ["Indie Rock", "Prog Rock"],
        formats: ["CD", "Vinyl"],
        countries: ["UK", "US"],
      });
    });

    it("returns empty arrays for a seller with no inventory", async () => {
      const res = await request(app).get("/sellers/unknown-seller/inventory/facets");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ genres: [], styles: [], formats: [], countries: [] });
    });
  });
});
