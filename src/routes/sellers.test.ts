import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Express } from "express";
import { createDb, type Db } from "../db/client";
import {
  discogsQueueJobs,
  discogsTokens,
  fades,
  releases,
  scanListings,
  scanPasses,
  sellerInventory,
  sellers,
} from "../db/schema";
import { NonRetryableError, QueueUnavailableError, SCAN_PRIORITY, DiscogsQueue } from "../queue/discogs-queue";
import { createApp } from "../app";

const { verifyIdToken } = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));

vi.mock("firebase-admin/app", () => ({
  cert: vi.fn(),
  getApps: vi.fn(() => []),
  initializeApp: vi.fn(),
}));

vi.mock("firebase-admin/auth", () => ({
  getAuth: vi.fn(() => ({ verifyIdToken })),
}));

describe("sellers routes", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;
  let app: Express;

  const auth = { Authorization: "Bearer test-token" };
  const get = (url: string) => request(app).get(url).set(auth);
  const post = (url: string) => request(app).post(url).set(auth);
  const del = (url: string, body?: object) => request(app).delete(url).set(auth).send(body);

  const addToken = (forUid = "u1") =>
    db.insert(discogsTokens).values({ uid: forUid, tokenEncrypted: "x", username: "dan", createdAt: new Date() }).run();
  const seedRelease = (id: number, title = `R${id}`, extra: Partial<typeof releases.$inferInsert> = {}) =>
    db.insert(releases).values({ id, title, genres: [], styles: [], formats: [], artists: [], ...extra }).run();
  const seedSeller = (username: string, extra: Partial<typeof sellers.$inferInsert> = {}) =>
    db.insert(sellers).values({ username, lastIndexStatus: "success", ...extra }).run();
  const seedItem = (seller: string, releaseId: number, status: "active" | "sold" = "active") =>
    db
      .insert(sellerInventory)
      .values({
        sellerUsername: seller,
        releaseId,
        status,
        firstSeenAt: new Date(1),
        lastSeenAt: new Date(1),
        soldAt: status === "sold" ? new Date(2) : null,
      })
      .run();
  const seedFade = (releaseId: number) =>
    db.insert(fades).values({ uid: "u1", kind: "release", id: releaseId, createdAt: new Date(1) }).run();
  const jobs = () => db.select().from(discogsQueueJobs).all();

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    queue = new DiscogsQueue(db);
    app = createApp({ db, queue });

    process.env.FIREBASE_PROJECT_ID = "test-project";
    process.env.FIREBASE_CLIENT_EMAIL = "test@test-project.iam.gserviceaccount.com";
    process.env.FIREBASE_PRIVATE_KEY = "test-key";
    process.env.ALLOWED_EMAILS = "dp.ceolpan@gmail.com";
    verifyIdToken.mockReset();
    verifyIdToken.mockResolvedValue({ uid: "u1", email: "dp.ceolpan@gmail.com" });
  });

  afterEach(() => {
    queue.stop();
    vi.restoreAllMocks();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  describe("POST /sellers/:username/index", () => {
    it("needs a Discogs token and queues nothing without one", async () => {
      const res = await post("/sellers/some-seller/index");

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("token_required");
      expect(jobs()).toEqual([]);
    });

    it("asks Discogs about an unknown username first, on the collector's lane", async () => {
      addToken();
      const enqueueAndWait = vi.spyOn(queue, "enqueueAndWait").mockImplementation(async (job) => {
        // The handler would create the seller and start its run under the job's run id.
        seedSeller("Some-Seller", { lastIndexStatus: "running", currentRunId: job.runId, runUid: "u1" });
      });

      const res = await post("/sellers/some-seller/index");

      expect(res.status).toBe(202);
      expect(res.body.username).toBe("Some-Seller");
      expect(enqueueAndWait).toHaveBeenCalledWith(
        expect.objectContaining({ type: "seller_profile", payload: { uid: "u1", username: "some-seller" } }),
      );
    });

    it("answers 404 when Discogs has no such user, and keeps nothing", async () => {
      addToken();
      vi.spyOn(queue, "enqueueAndWait").mockRejectedValue(new NonRetryableError("404"));

      const res = await post("/sellers/nobody/index");

      expect(res.status).toBe(404);
      expect(db.select().from(sellers).all()).toEqual([]);
    });

    it("answers 503 while Discogs is paused", async () => {
      addToken();
      vi.spyOn(queue, "enqueueAndWait").mockRejectedValue(new QueueUnavailableError("paused"));

      const res = await post("/sellers/some-seller/index");

      expect(res.status).toBe(503);
    });

    it("runs a known seller again, whatever the casing, on the starting collector's token", async () => {
      addToken();
      seedSeller("Some-Seller", { inventoryTotal: 5, scanPagesFetched: 3 });
      db.insert(scanListings)
        .values({ runId: "old", sellerUsername: "Some-Seller", sort: "artist", order: "asc", listingId: 1 })
        .run();

      const res = await post("/sellers/some-seller/index");

      expect(res.status).toBe(202);
      expect(res.body.username).toBe("Some-Seller");
      const [seller] = db.select().from(sellers).all();
      expect(seller).toMatchObject({
        lastIndexStatus: "running",
        currentRunId: res.body.runId,
        runUid: "u1",
        inventoryTotal: null,
        scanPagesFetched: 0,
      });
      expect(db.select().from(scanListings).all()).toEqual([]);
      expect(jobs()).toEqual([
        expect.objectContaining({
          uid: "u1",
          runId: res.body.runId,
          type: "inventory_page",
          priority: SCAN_PRIORITY,
          payload: expect.objectContaining({ uid: "u1", username: "Some-Seller", page: 1 }),
        }),
      ]);
    });

    it("answers 409 while the seller is already running", async () => {
      addToken();
      seedSeller("Some-Seller", { lastIndexStatus: "running", currentRunId: "run-1", runUid: "u2" });

      const res = await post("/sellers/some-seller/index");

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("run_active");
      expect(jobs()).toEqual([]);
    });
  });

  describe("GET /sellers", () => {
    it("lists sellers with their for-sale and faded counts and their coverage", async () => {
      seedRelease(1);
      seedRelease(2);
      seedRelease(3);
      seedSeller("beta", { inventoryTotal: 20_000, avatarUrl: "https://img/beta.png" });
      seedSeller("alpha", { inventoryTotal: 50 });
      seedItem("beta", 1);
      seedItem("beta", 2);
      seedItem("beta", 3, "sold");
      seedFade(2);

      const res = await get("/sellers");

      expect(res.status).toBe(200);
      expect(res.body.map((s: { username: string }) => s.username)).toEqual(["alpha", "beta"]);
      expect(res.body[1]).toMatchObject({
        username: "beta",
        avatarUrl: "https://img/beta.png",
        forSaleCount: 2,
        fadedCount: 1,
        coverage: { reachable: 10_000, total: 20_000 },
      });
      expect(res.body[0]).toMatchObject({ forSaleCount: 0, fadedCount: 0 });
    });
  });

  describe("GET /sellers/:username", () => {
    it("reports the scan, its passes and the enrichment progress of the current run", async () => {
      seedSeller("beta", {
        lastIndexStatus: "running",
        currentRunId: "run-1",
        runUid: "u1",
        inventoryTotal: 300,
        scanPagesTotal: 6,
        scanPagesFetched: 3,
      });
      db.insert(scanPasses)
        .values({
          runId: "run-1",
          sellerUsername: "beta",
          sort: "artist",
          order: "asc",
          pagesPlanned: 3,
          pagesFetched: 3,
          itemsSeen: 300,
          itemsNew: 300,
          status: "done",
          startedAt: new Date(1000),
          endedAt: new Date(2000),
        })
        .run();
      const now = new Date();
      for (const status of ["done", "pending"] as const) {
        db.insert(discogsQueueJobs)
          .values({ uid: "u1", runId: "run-1", type: "release_detail", payload: { uid: "u1", releaseId: 1 }, status, createdAt: now, updatedAt: now })
          .run();
      }

      const res = await get("/sellers/beta");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        username: "beta",
        currentlyRunning: true,
        phase: "scanning",
        scan: { pagesFetched: 3, pagesTotal: 6 },
        totalReleasesFound: 2,
        releasesEnriched: 1,
        retryingAt: null,
      });
      expect(res.body.scanPasses).toEqual([
        expect.objectContaining({ sort: "artist", order: "asc", status: "done", pagesFetched: 3, itemsSeen: 300 }),
      ]);
    });

    it("is in the enriching phase once the scan has ended", async () => {
      seedSeller("beta", { lastIndexStatus: "running", currentRunId: "run-1", scanCompletedAt: new Date(1) });

      const res = await get("/sellers/beta");

      expect(res.body.phase).toBe("enriching");
    });

    it("answers 404 for a seller that was never indexed", async () => {
      expect((await get("/sellers/nobody")).status).toBe(404);
    });
  });

  describe("DELETE /sellers/:username", () => {
    it("removes the seller, its inventory and scan records and its queued run, but not the releases", async () => {
      seedRelease(1);
      seedSeller("beta", { lastIndexStatus: "running", currentRunId: "run-1" });
      seedSeller("keep");
      seedItem("beta", 1);
      seedItem("keep", 1);
      db.insert(scanListings)
        .values({ runId: "run-1", sellerUsername: "beta", sort: "artist", order: "asc", listingId: 1 })
        .run();
      const now = new Date();
      db.insert(discogsQueueJobs)
        .values({ uid: "u1", runId: "run-1", type: "release_detail", payload: { uid: "u1", releaseId: 1 }, createdAt: now, updatedAt: now })
        .run();

      const res = await del("/sellers/beta");

      expect(res.status).toBe(204);
      expect(db.select().from(sellers).all().map((s) => s.username)).toEqual(["keep"]);
      expect(db.select().from(sellerInventory).all().map((i) => i.sellerUsername)).toEqual(["keep"]);
      expect(db.select().from(scanListings).all()).toEqual([]);
      expect(jobs()).toEqual([]);
      expect(db.select().from(releases).all()).toHaveLength(1);
    });

    it("answers 404 for a seller that was never indexed", async () => {
      expect((await del("/sellers/nobody")).status).toBe(404);
    });
  });

  describe("GET /releases?seller=", () => {
    it("keeps the releases the seller lists for sale now, not sold ones or other sellers'", async () => {
      seedRelease(1, "Listed");
      seedRelease(2, "Sold");
      seedRelease(3, "Someone else's");
      seedRelease(4, "Nobody lists");
      seedSeller("beta");
      seedSeller("gamma");
      seedItem("beta", 1);
      seedItem("beta", 2, "sold");
      seedItem("gamma", 3);

      const res = await get("/releases?seller=beta");

      expect(res.status).toBe(200);
      expect(res.body.items.map((item: { title: string }) => item.title)).toEqual(["Listed"]);
      expect(res.body.total).toBe(1);
    });

    it("combines with the other filters", async () => {
      seedRelease(1, "Listed");
      seedRelease(2, "Also listed");
      seedSeller("beta");
      seedItem("beta", 1);
      seedItem("beta", 2);

      const res = await get("/releases?seller=beta&q=Also");

      expect(res.body.items.map((item: { title: string }) => item.title)).toEqual(["Also listed"]);
    });
  });

  describe("DELETE /fade requeues what the scan skipped", () => {
    it("queues a release a seller lists that has no row yet and that no fade covers any more", async () => {
      addToken();
      seedSeller("beta");
      seedItem("beta", 77);
      seedFade(77);

      const res = await del("/fade", { releaseId: 77 });

      expect(res.status).toBe(204);
      expect(jobs()).toEqual([
        expect.objectContaining({ uid: "u1", type: "release_detail", payload: { uid: "u1", releaseId: 77 } }),
      ]);
      expect(db.select().from(fades).where(eq(fades.id, 77)).all()).toEqual([]);
    });

    it("queues a release the catalogue has but no enrichment run has fetched", async () => {
      addToken();
      seedSeller("beta");
      seedRelease(8);
      seedItem("beta", 8);
      seedFade(8);

      await del("/fade", { releaseId: 8 });

      expect(jobs()).toEqual([
        expect.objectContaining({ type: "release_detail", payload: { uid: "u1", releaseId: 8 } }),
      ]);
    });

    it("queues nothing for a release that is already enriched or no seller lists", async () => {
      addToken();
      seedSeller("beta");
      seedRelease(5, "R5", { enrichedAt: new Date(1) });
      seedItem("beta", 5);
      seedFade(5);
      seedFade(6);

      await del("/fade", { releaseId: 5 });
      await del("/fade", { releaseId: 6 });

      expect(jobs()).toEqual([]);
    });
  });
});
