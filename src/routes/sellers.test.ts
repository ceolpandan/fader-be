import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Express } from "express";
import { createDb, type Db } from "../db/client";
import { discogsQueueJobs, fades, releases, scanListings, scanPasses, sellerInventory, sellerListings, sellers } from "../db/schema";
import { DiscogsNotFoundError, DiscogsTransientError } from "../discogs-client";
import type { DiscogsInventoryPage } from "../types/discogs-api";
import type { DiscogsReads } from "./sellers";
import { createSellerProfileHandler } from "../indexing/seller-profile-handler";
import {
  DiscogsQueue,
  NonRetryableError,
  PACING_MS,
  QueueUnavailableError,
  QueueWaitTimeoutError,
} from "../queue/discogs-queue";
import { checkRunCompletion } from "../indexing/run-completion";
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

const TEST_TOKEN = "test-token";

function authedRequest(app: Express) {
  const agent = request(app);
  return {
    get: (url: string) => agent.get(url).set("Authorization", `Bearer ${TEST_TOKEN}`),
    post: (url: string) => agent.post(url).set("Authorization", `Bearer ${TEST_TOKEN}`),
    delete: (url: string) => agent.delete(url).set("Authorization", `Bearer ${TEST_TOKEN}`),
  };
}

describe("sellers routes", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;
  let app: Express;

  /** The queue is not running here, so settle a seller_profile job inline with the real handler. */
  function useProfileLookup(getUserProfile: (username: string) => Promise<{ username: string }>): void {
    const handler = createSellerProfileHandler({
      db,
      enqueue: (job) => queue.enqueue(job),
      getUserProfile,
    });
    vi.spyOn(queue, "enqueueAndWait").mockImplementation(async (job) => {
      await handler(job.payload as { username: string }, { runId: job.runId, jobId: 0 });
    });
  }

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    queue = new DiscogsQueue(db);
    queue.onSettled((job) => checkRunCompletion(db, job.runId));
    app = createApp({ db, queue });
    useProfileLookup(async (username) => ({ username }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    process.env.FIREBASE_PROJECT_ID = "test-project";
    process.env.FIREBASE_CLIENT_EMAIL = "test@test-project.iam.gserviceaccount.com";
    process.env.FIREBASE_PRIVATE_KEY = "test-key";
    process.env.ALLOWED_EMAILS = "dp.ceolpan@gmail.com";
    verifyIdToken.mockReset();
    verifyIdToken.mockResolvedValue({ uid: "test-uid", email: "dp.ceolpan@gmail.com" });
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
      const res = await authedRequest(app).post("/sellers/some-seller/index").send();

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

    it("does not leave a seller behind when enqueueing the first job fails", async () => {
      vi.spyOn(queue, "enqueue").mockImplementation(() => {
        throw new Error("disk full");
      });

      const res = await authedRequest(app).post("/sellers/some-seller/index").send();

      expect(res.status).toBe(502);
      expect(db.select().from(sellers).where(eq(sellers.username, "some-seller")).all()).toEqual([]);
    });

    it("returns 404 and creates nothing when Discogs has no such user", async () => {
      useProfileLookup(async () => {
        throw new NonRetryableError("not found");
      });

      const res = await authedRequest(app).post("/sellers/nobody-here/index").send();

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "No Discogs user named 'nobody-here'" });
      expect(db.select().from(sellers).all()).toEqual([]);
      expect(db.select().from(discogsQueueJobs).all()).toEqual([]);
    });

    it("returns 503 or 504 and creates nothing while Discogs is unavailable", async () => {
      vi.spyOn(queue, "enqueueAndWait").mockRejectedValueOnce(new QueueUnavailableError("x"));
      const unavailable = await authedRequest(app).post("/sellers/some-seller/index").send();
      expect(unavailable.status).toBe(503);

      vi.spyOn(queue, "enqueueAndWait").mockRejectedValueOnce(new QueueWaitTimeoutError("x"));
      const timedOut = await authedRequest(app).post("/sellers/some-seller/index").send();
      expect(timedOut.status).toBe(504);

      expect(db.select().from(sellers).all()).toEqual([]);
    });

    it("stores the seller under the casing Discogs reports", async () => {
      useProfileLookup(async () => ({ username: "FooBar" }));

      const res = await authedRequest(app).post("/sellers/foobar/index").send();

      expect(res.status).toBe(202);
      expect(res.body.username).toBe("FooBar");
      expect(db.select().from(sellers).all().map((s) => s.username)).toEqual(["FooBar"]);
    });

    it("matches an existing seller case-insensitively instead of creating a second", async () => {
      useProfileLookup(async () => ({ username: "FooBar" }));
      await authedRequest(app).post("/sellers/FooBar/index").send();
      db.update(sellers).set({ lastIndexStatus: "success" }).run();

      const again = await authedRequest(app).post("/sellers/foobar/index").send();
      expect(again.status).toBe(202);
      expect(again.body.username).toBe("FooBar");
      expect(db.select().from(sellers).all()).toHaveLength(1);

      const running = await authedRequest(app).post("/sellers/FOOBAR/index").send();
      expect(running.status).toBe(409);
    });

    it("trims the username before checking it", async () => {
      const res = await authedRequest(app).post("/sellers/%20some-seller%20/index").send();
      expect(res.status).toBe(202);
      expect(res.body.username).toBe("some-seller");
    });

    it("returns 400 for a blank username", async () => {
      const res = await authedRequest(app).post("/sellers/%20/index").send();
      expect(res.status).toBe(400);
    });

    it("returns 409 if indexing is already running for that username", async () => {
      const first = await authedRequest(app).post("/sellers/some-seller/index").send();
      expect(first.status).toBe(202);

      const second = await authedRequest(app).post("/sellers/some-seller/index").send();
      expect(second.status).toBe(409);
    });

    it("allows re-indexing once the previous run has finished", async () => {
      const first = await authedRequest(app).post("/sellers/some-seller/index").send();
      expect(first.status).toBe(202);

      db.update(sellers)
        .set({ lastIndexStatus: "success" })
        .where(eq(sellers.username, "some-seller"))
        .run();

      const second = await authedRequest(app).post("/sellers/some-seller/index").send();
      expect(second.status).toBe(202);
    });
  });

  describe("GET /sellers/:username/preview", () => {
    const profile = {
      username: "Some-Seller",
      seller_rating: 98.4,
      seller_num_ratings: 1203,
      avatar_url: "https://img.discogs.com/avatar.jpg",
      num_for_sale: 250,
    };
    const inventoryPage = { listings: [{ ships_from: "Germany" }] } as unknown as DiscogsInventoryPage;

    function previewApp(discogs: DiscogsReads): Express {
      return createApp({ db, queue, discogs });
    }

    it("describes the seller from Discogs and stores nothing", async () => {
      const getInventory = vi.fn().mockResolvedValue(inventoryPage);
      const app = previewApp({ getUserProfile: vi.fn().mockResolvedValue(profile), getInventory });

      const res = await authedRequest(app).get("/sellers/some-seller/preview");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        username: "Some-Seller",
        avatarUrl: "https://img.discogs.com/avatar.jpg",
        sellerRating: 98.4,
        sellerNumRatings: 1203,
        shipsFromCountry: "Germany",
        numForSale: 250,
        marketplaceSuspended: false,
        // 250 releases + 3 inventory pages, at PACING_MS each.
        estimatedSeconds: Math.round((253 * PACING_MS) / 1000),
      });
      expect(getInventory).toHaveBeenCalledWith("Some-Seller", 1);
      expect(db.select().from(sellers).all()).toEqual([]);
    });

    it("returns 404 when Discogs has no such user", async () => {
      const getUserProfile = vi.fn().mockRejectedValue(new DiscogsNotFoundError("nope"));
      const res = await authedRequest(previewApp({ getUserProfile, getInventory: vi.fn() })).get(
        "/sellers/ghost/preview",
      );
      expect(res.status).toBe(404);
    });

    it("returns 503 while Discogs is unavailable", async () => {
      const getUserProfile = vi.fn().mockRejectedValue(new DiscogsTransientError("429"));
      const res = await authedRequest(previewApp({ getUserProfile, getInventory: vi.fn() })).get(
        "/sellers/some-seller/preview",
      );
      expect(res.status).toBe(503);
    });

    it("returns 400 for a blank username", async () => {
      const res = await authedRequest(previewApp({ getUserProfile: vi.fn(), getInventory: vi.fn() })).get(
        "/sellers/%20/preview",
      );
      expect(res.status).toBe(400);
    });

    it("leaves ships-from empty when the listing lookup fails", async () => {
      const app = previewApp({
        getUserProfile: vi.fn().mockResolvedValue(profile),
        getInventory: vi.fn().mockRejectedValue(new DiscogsTransientError("boom")),
      });
      const res = await authedRequest(app).get("/sellers/some-seller/preview");
      expect(res.status).toBe(200);
      expect(res.body.shipsFromCountry).toBeNull();
    });

    it("skips the listing lookup for a seller with no listings, and reports no rating for one who never sold", async () => {
      const getInventory = vi.fn();
      const app = previewApp({
        getUserProfile: vi.fn().mockResolvedValue({
          username: "empty",
          seller_rating: 0,
          seller_num_ratings: 0,
          num_for_sale: 0,
          marketplace_suspended: true,
        }),
        getInventory,
      });
      const res = await authedRequest(app).get("/sellers/empty/preview");
      expect(res.body).toMatchObject({
        sellerRating: null,
        sellerNumRatings: null,
        avatarUrl: null,
        numForSale: 0,
        marketplaceSuspended: true,
        estimatedSeconds: 0,
      });
      expect(getInventory).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /sellers/:username", () => {
    const release = {
      id: 1,
      title: "T",
      year: null,
      country: null,
      genres: [],
      styles: [],
      formats: [],
      masterId: null,
      thumb: null,
      ratingAverage: null,
      ratingCount: null,
      haves: null,
      wants: null,
      labelIds: [],
      artists: [],
    };

    it("returns 404 for a username that has never been indexed", async () => {
      const res = await authedRequest(app).delete("/sellers/unknown-seller");
      expect(res.status).toBe(404);
    });

    it("removes the seller, its inventory, scan passes and jobs, and keeps releases and fades", async () => {
      await authedRequest(app).post("/sellers/some-seller/index").send();
      await authedRequest(app).post("/sellers/other-seller/index").send();
      const now = new Date();
      db.insert(releases).values(release).run();
      db.insert(sellerInventory)
        .values([
          { sellerUsername: "some-seller", releaseId: 1, status: "active", firstSeenAt: now, lastSeenAt: now },
          { sellerUsername: "other-seller", releaseId: 1, status: "active", firstSeenAt: now, lastSeenAt: now },
        ])
        .run();
      db.insert(scanPasses)
        .values([
          { runId: "r1", sellerUsername: "some-seller", sort: "artist", order: "asc", pagesPlanned: 1, status: "done", startedAt: now },
          { runId: "r2", sellerUsername: "other-seller", sort: "artist", order: "asc", pagesPlanned: 1, status: "done", startedAt: now },
        ])
        .run();
      db.insert(scanListings)
        .values([
          { runId: "r1", sellerUsername: "some-seller", sort: "artist", order: "asc", listingId: 1 },
          { runId: "r2", sellerUsername: "other-seller", sort: "artist", order: "asc", listingId: 1 },
        ])
        .run();
      db.insert(fades).values({ uid: "test-uid", kind: "release", id: 1, createdAt: now }).run();
      db.insert(sellerListings)
        .values([
          { listingId: 1, sellerUsername: "some-seller", releaseId: 1, mediaCondition: "Mint (M)", price: 5, currency: "USD", lastSeenAt: now },
          { listingId: 2, sellerUsername: "other-seller", releaseId: 1, mediaCondition: "Mint (M)", price: 5, currency: "USD", lastSeenAt: now },
        ])
        .run();

      const res = await authedRequest(app).delete("/sellers/some-seller");

      expect(res.status).toBe(204);
      expect(db.select().from(sellers).all().map((s) => s.username)).toEqual(["other-seller"]);
      expect(db.select().from(sellerInventory).all().map((i) => i.sellerUsername)).toEqual(["other-seller"]);
      expect(db.select().from(scanPasses).all().map((s) => s.sellerUsername)).toEqual(["other-seller"]);
      expect(db.select().from(scanListings).all().map((l) => l.sellerUsername)).toEqual(["other-seller"]);
      expect(db.select().from(sellerListings).all().map((l) => l.sellerUsername)).toEqual(["other-seller"]);
      expect(
        db.select().from(discogsQueueJobs).all().map((j) => (j.payload as { username: string }).username),
      ).toEqual(["other-seller"]);
      expect(db.select().from(releases).all()).toHaveLength(1);
      expect(db.select().from(fades).all()).toHaveLength(1);
    });

    it("stops a running run: its queued release_detail jobs go too", async () => {
      const started = await authedRequest(app).post("/sellers/some-seller/index").send();
      queue.enqueue({ runId: started.body.runId, type: "release_detail", payload: { releaseId: 5 } });

      await authedRequest(app).delete("/sellers/some-seller");

      expect(db.select().from(discogsQueueJobs).all()).toEqual([]);
    });

    it("lets the username be indexed again afterwards", async () => {
      await authedRequest(app).post("/sellers/some-seller/index").send();
      await authedRequest(app).delete("/sellers/some-seller");

      const res = await authedRequest(app).post("/sellers/some-seller/index").send();
      expect(res.status).toBe(202);
    });
  });

  describe("GET /sellers/:username", () => {
    it("returns 404 for a username that has never been indexed", async () => {
      const res = await authedRequest(app).get("/sellers/unknown-seller");
      expect(res.status).toBe(404);
    });

    it("returns seller rating and ships-from country, null until indexed", async () => {
      await authedRequest(app).post("/sellers/some-seller/index").send();

      const before = await authedRequest(app).get("/sellers/some-seller");
      expect(before.body).toMatchObject({ sellerRating: null, sellerNumRatings: null, shipsFromCountry: null });

      db.update(sellers)
        .set({ sellerRating: 96.4, sellerNumRatings: 174, shipsFromCountry: "Germany" })
        .where(eq(sellers.username, "some-seller"))
        .run();

      const after = await authedRequest(app).get("/sellers/some-seller");
      expect(after.body).toMatchObject({ sellerRating: 96.4, sellerNumRatings: 174, shipsFromCountry: "Germany" });
    });

    it("reflects live release_detail job counts for the current run as they change", async () => {
      const started = await authedRequest(app).post("/sellers/some-seller/index").send();
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

      let res = await authedRequest(app).get("/sellers/some-seller");
      expect(res.body).toMatchObject({
        currentlyRunning: true,
        totalReleasesFound: 2,
        releasesEnriched: 0,
        releasesFailed: 0,
      });

      db.update(discogsQueueJobs).set({ status: "done" }).where(eq(discogsQueueJobs.id, jobA.id)).run();
      db.update(discogsQueueJobs).set({ status: "failed" }).where(eq(discogsQueueJobs.id, jobB.id)).run();

      res = await authedRequest(app).get("/sellers/some-seller");
      expect(res.body).toMatchObject({
        currentlyRunning: true,
        totalReleasesFound: 2,
        releasesEnriched: 1,
        releasesFailed: 1,
      });
    });

    describe("indexing progress", () => {
      const start = async () => {
        const started = await authedRequest(app).post("/sellers/some-seller/index").send();
        return (started.body as { runId: string }).runId;
      };
      const seller = (set: Partial<typeof sellers.$inferInsert>) =>
        db.update(sellers).set(set).where(eq(sellers.username, "some-seller")).run();
      const insertDoneJobs = (runId: string, count: number, spacingMs: number) => {
        for (let i = 0; i < count; i++) {
          const at = new Date(Date.now() - (count - i) * spacingMs);
          db.insert(discogsQueueJobs)
            .values({
              runId,
              type: "release_detail",
              payload: { releaseId: i },
              status: "done",
              createdAt: at,
              updatedAt: at,
            })
            .run();
        }
      };
      const insertPendingJobs = (runId: string, count: number) => {
        const now = new Date();
        for (let i = 0; i < count; i++) {
          db.insert(discogsQueueJobs)
            .values({
              runId,
              type: "release_detail",
              payload: { releaseId: 1000 + i },
              status: "pending",
              createdAt: now,
              updatedAt: now,
            })
            .run();
        }
      };

      it("is scanning, with no scan data or coverage, right after indexing starts", async () => {
        await start();

        const res = await authedRequest(app).get("/sellers/some-seller");
        expect(res.body).toMatchObject({
          phase: "scanning",
          scan: null,
          coverage: null,
          etaSeconds: null,
          retryingAt: null,
          backoffMs: null,
        });
      });

      it("reports scan progress and coverage while scanning", async () => {
        await start();
        seller({ inventoryTotal: 42_223, scanPagesTotal: 100, scanPagesFetched: 12 });

        const res = await authedRequest(app).get("/sellers/some-seller");
        expect(res.body).toMatchObject({
          phase: "scanning",
          scan: { pagesFetched: 12, pagesTotal: 100 },
          coverage: { reachable: 10_000, total: 42_223 },
        });
      });

      describe("scan passes", () => {
        const pass = (runId: string, order: "asc" | "desc", itemsSeen: number, status: "running" | "done" | "capped" | "failed") =>
          db
            .insert(scanPasses)
            .values({
              runId,
              sellerUsername: "some-seller",
              sort: "artist",
              order,
              pagesPlanned: 100,
              pagesFetched: itemsSeen / 100,
              itemsSeen,
              itemsNew: itemsSeen,
              status,
              startedAt: new Date("2026-01-01T00:00:00.000Z"),
              endedAt: status === "running" ? null : new Date("2026-01-01T00:02:00.000Z"),
            })
            .run();

        it("lists the current run's passes in the order they ran", async () => {
          const runId = await start();
          pass(runId, "asc", 10_000, "done");
          pass(runId, "desc", 5_000, "running");
          pass("older-run", "asc", 777, "done");

          const res = await authedRequest(app).get("/sellers/some-seller");

          expect(res.body.scanPasses).toEqual([
            {
              sort: "artist",
              order: "asc",
              status: "done",
              pagesPlanned: 100,
              pagesFetched: 100,
              itemsSeen: 10_000,
              itemsNew: 10_000,
              startedAt: "2026-01-01T00:00:00.000Z",
              endedAt: "2026-01-01T00:02:00.000Z",
            },
            expect.objectContaining({ order: "desc", status: "running", endedAt: null }),
          ]);
        });

        const seen = (count: number, lastSeenAt: Date) => {
          for (let i = 0; i < count; i += 1) {
            db.insert(sellerInventory)
              .values({
                sellerUsername: "some-seller",
                releaseId: lastSeenAt.getFullYear() * 1000 + i,
                status: "active",
                firstSeenAt: lastSeenAt,
                lastSeenAt,
                soldAt: null,
              })
              .run();
          }
        };

        /** Listing ids `from`..`to` read by the pass of `sort` and `order`. */
        const read = (runId: string, order: "asc" | "desc", from: number, to: number) => {
          for (let listingId = from; listingId <= to; listingId += 1) {
            db.insert(scanListings)
              .values({ runId, sellerUsername: "some-seller", sort: "artist", order, listingId })
              .run();
          }
        };

        it("counts the distinct items seen since the run's first pass began, a count that grows while scanning", async () => {
          const runId = await start();
          seller({ inventoryTotal: 42_223, scanPagesTotal: 1400, scanPagesFetched: 12 });
          pass(runId, "asc", 1_200, "running");
          seen(120, new Date("2026-01-01T00:01:00.000Z"));
          seen(30, new Date("2025-12-01T00:00:00.000Z"));

          const res = await authedRequest(app).get("/sellers/some-seller");

          expect(res.body.coverage).toEqual({ reachable: 120, total: 42_223 });
        });

        it("counts an item both passes saw once", async () => {
          const runId = await start();
          seller({ inventoryTotal: 42_223, scanCompletedAt: new Date() });
          pass(runId, "asc", 10_000, "done");
          pass(runId, "desc", 4_000, "capped");
          seen(140, new Date("2026-01-01T00:01:00.000Z"));

          const res = await authedRequest(app).get("/sellers/some-seller");

          expect(res.body.coverage).toEqual({ reachable: 140, total: 42_223 });
        });

        it("reports the distinct items as the whole inventory once a single pass returned every listing, even with several copies of a release", async () => {
          const runId = await start();
          seller({ inventoryTotal: 50, scanCompletedAt: new Date() });
          pass(runId, "asc", 50, "done");
          read(runId, "asc", 1, 50);
          seen(40, new Date("2026-01-01T00:01:00.000Z"));

          const res = await authedRequest(app).get("/sellers/some-seller");

          expect(res.body.coverage).toEqual({ reachable: 40, total: 40 });
        });

        it("reports the distinct items as the whole inventory once the ascending and descending passes of one sort saw every listing", async () => {
          const runId = await start();
          seller({ inventoryTotal: 15_308, scanCompletedAt: new Date() });
          pass(runId, "asc", 10_000, "done");
          pass(runId, "desc", 5_400, "done");
          read(runId, "asc", 1, 10_000);
          read(runId, "desc", 9_909, 15_308);
          seen(140, new Date("2026-01-01T00:01:00.000Z"));

          const res = await authedRequest(app).get("/sellers/some-seller");

          expect(res.body.coverage).toEqual({ reachable: 140, total: 140 });
        });

        it("is not covered while fewer distinct listings were read than Discogs reports, however many items the passes returned", async () => {
          const runId = await start();
          seller({ inventoryTotal: 15_308, scanCompletedAt: new Date() });
          pass(runId, "asc", 10_000, "done");
          pass(runId, "desc", 5_400, "done");
          read(runId, "asc", 1, 10_000);
          read(runId, "desc", 9_909, 15_000);
          seen(140, new Date("2026-01-01T00:01:00.000Z"));

          const res = await authedRequest(app).get("/sellers/some-seller");

          expect(res.body.coverage).toEqual({ reachable: 140, total: 15_308 });
        });

        it("has no passes before the scan starts", async () => {
          await start();

          const res = await authedRequest(app).get("/sellers/some-seller");

          expect(res.body.scanPasses).toEqual([]);
        });
      });

      it("is enriching once the scan has completed", async () => {
        await start();
        seller({ inventoryTotal: 500, scanPagesTotal: 5, scanPagesFetched: 5, scanCompletedAt: new Date() });

        const res = await authedRequest(app).get("/sellers/some-seller");
        expect(res.body).toMatchObject({ phase: "enriching", coverage: { reachable: 500, total: 500 } });
      });

      it("has no ETA until enough releases have been enriched", async () => {
        const runId = await start();
        seller({ scanCompletedAt: new Date() });
        insertDoneJobs(runId, 9, 1300);
        insertPendingJobs(runId, 50);

        const res = await authedRequest(app).get("/sellers/some-seller");
        expect(res.body.etaSeconds).toBeNull();
      });

      it("estimates the ETA from the recent completion pace", async () => {
        const runId = await start();
        seller({ scanCompletedAt: new Date() });
        insertDoneJobs(runId, 30, 2000);
        insertPendingJobs(runId, 100);

        const res = await authedRequest(app).get("/sellers/some-seller");
        // 100 remaining at one job per 2s
        expect(res.body.etaSeconds).toBe(200);
      });

      it("ignores long pause gaps between completed jobs when estimating the pace", async () => {
        const runId = await start();
        seller({ scanCompletedAt: new Date() });
        insertDoneJobs(runId, 10, 2000);
        // a 10 minute Discogs pause sits between the older and the newer completions
        const pauseAt = new Date(Date.now() - 60_000);
        db.insert(discogsQueueJobs)
          .values({
            runId,
            type: "release_detail",
            payload: { releaseId: 500 },
            status: "done",
            createdAt: pauseAt,
            updatedAt: new Date(pauseAt.getTime() - 600_000),
          })
          .run();
        insertPendingJobs(runId, 100);

        const res = await authedRequest(app).get("/sellers/some-seller");
        expect(res.body.etaSeconds).toBe(200);
      });

      describe("while the Discogs queue is paused", () => {
        // Starting an index also queued an inventory_page job, which the queue handles first.
        const pauseQueue = async () => {
          queue.registerHandler("inventory_page", async () => {});
          queue.registerHandler("release_detail", async () => {
            throw new DiscogsTransientError("discogs is down");
          });
          queue.start();
          await vi.advanceTimersByTimeAsync(PACING_MS);
        };

        it("reports when the queue retries and how long the pause is", async () => {
          const runId = await start();
          insertPendingJobs(runId, 1);
          await pauseQueue();

          const res = await authedRequest(app).get("/sellers/some-seller");
          expect(res.body).toMatchObject({
            retryingAt: new Date(Date.now() + 60_000).toISOString(),
            backoffMs: 60_000,
            lastIndexStatus: "running",
          });
        });

        it("adds the remaining pause to the ETA", async () => {
          const runId = await start();
          seller({ scanCompletedAt: new Date() });
          insertDoneJobs(runId, 30, 2000);
          insertPendingJobs(runId, 100);
          await pauseQueue();

          const res = await authedRequest(app).get("/sellers/some-seller");
          // 100 remaining at one job per 2s, plus the 60s pause
          expect(res.body.etaSeconds).toBe(260);
        });

        it("reports no pause for a seller that is not running", async () => {
          const runId = await start();
          insertPendingJobs(runId, 1);
          await pauseQueue();
          seller({ lastIndexStatus: "success" });

          const res = await authedRequest(app).get("/sellers/some-seller");
          expect(res.body).toMatchObject({ retryingAt: null, backoffMs: null });
        });
      });

      it("is done and keeps its coverage after the run finishes", async () => {
        await start();
        seller({ lastIndexStatus: "success", inventoryTotal: 42_223, scanPagesTotal: 100, scanPagesFetched: 100 });

        const res = await authedRequest(app).get("/sellers/some-seller");
        expect(res.body).toMatchObject({
          phase: "done",
          etaSeconds: null,
          coverage: { reachable: 10_000, total: 42_223 },
        });
      });

      it("clears the previous run's scan state when indexing again", async () => {
        await start();
        seller({
          lastIndexStatus: "success",
          inventoryTotal: 42_223,
          scanPagesTotal: 100,
          scanPagesFetched: 100,
          scanCompletedAt: new Date(),
        });

        await start();

        const res = await authedRequest(app).get("/sellers/some-seller");
        expect(res.body).toMatchObject({ phase: "scanning", scan: null, coverage: null });
      });

      it("forgets the listings the previous run read when indexing again", async () => {
        const firstRun = await start();
        db.insert(scanListings)
          .values({ runId: firstRun, sellerUsername: "some-seller", sort: "artist", order: "asc", listingId: 1 })
          .run();
        seller({ lastIndexStatus: "success", scanCompletedAt: new Date() });

        await start();

        expect(db.select().from(scanListings).all()).toEqual([]);
      });
    });

    it("flips to success (currentlyRunning: false) once the whole run settles, end to end", async () => {
      queue.registerHandler("inventory_page", vi.fn(async () => {}));
      queue.registerHandler("release_detail", vi.fn(async () => {}));

      await authedRequest(app).post("/sellers/some-seller/index").send();

      queue.start();
      await vi.advanceTimersByTimeAsync(0);

      const res = await authedRequest(app).get("/sellers/some-seller");
      expect(res.body).toMatchObject({
        lastIndexStatus: "success",
        currentlyRunning: false,
      });
      expect(res.body.lastIndexedAt).not.toBeNull();
    });
  });

  describe("GET /sellers", () => {
    it("lists every seller that has ever been indexed", async () => {
      await authedRequest(app).post("/sellers/seller-a/index").send();
      await authedRequest(app).post("/sellers/seller-b/index").send();
      db.update(sellers).set({ lastIndexStatus: "success" }).where(eq(sellers.username, "seller-a")).run();

      const res = await authedRequest(app).get("/sellers");
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
      const res = await authedRequest(app).get("/sellers");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    describe("counters", () => {
      function seedItem(
        username: string,
        releaseId: number,
        { status = "active", masterId = null }: { status?: "active" | "sold"; masterId?: number | null } = {},
      ) {
        const now = new Date();
        db.insert(releases)
          .values({
            id: releaseId,
            title: `R${releaseId}`,
            masterId,
            genres: [],
            styles: [],
            formats: [],
            labelIds: [],
            artists: [],
          })
          .onConflictDoNothing()
          .run();
        db.insert(sellerInventory)
          .values({ sellerUsername: username, releaseId, status, firstSeenAt: now, lastSeenAt: now, soldAt: null })
          .run();
      }

      async function listed(username: string) {
        const res = await authedRequest(app).get("/sellers");
        return res.body.find((s: { username: string }) => s.username === username);
      }

      beforeEach(async () => {
        await authedRequest(app).post("/sellers/seller-a/index").send();
      });

      it("counts the active, enriched items for sale, and none for a seller with none", async () => {
        seedItem("seller-a", 1);
        seedItem("seller-a", 2);
        seedItem("seller-a", 3, { status: "sold" });
        // Discovered but not enriched yet: no releases row.
        db.insert(sellerInventory)
          .values({
            sellerUsername: "seller-a",
            releaseId: 4,
            status: "active",
            firstSeenAt: new Date(),
            lastSeenAt: new Date(),
            soldAt: null,
          })
          .run();
        await authedRequest(app).post("/sellers/seller-b/index").send();

        expect(await listed("seller-a")).toMatchObject({ forSaleCount: 2, fadedCount: 0 });
        expect(await listed("seller-b")).toMatchObject({ forSaleCount: 0, fadedCount: 0 });
      });

      it("counts the items faded for the collector, by release or by master", async () => {
        seedItem("seller-a", 1);
        seedItem("seller-a", 2, { masterId: 50 });
        seedItem("seller-a", 3);
        db.insert(fades).values({ uid: "test-uid", kind: "release", id: 1, createdAt: new Date() }).run();
        db.insert(fades).values({ uid: "test-uid", kind: "master", id: 50, createdAt: new Date() }).run();

        expect(await listed("seller-a")).toMatchObject({ forSaleCount: 3, fadedCount: 2 });
      });

      it("ignores other collectors' fades", async () => {
        seedItem("seller-a", 1);
        db.insert(fades).values({ uid: "someone-else", kind: "release", id: 1, createdAt: new Date() }).run();

        expect(await listed("seller-a")).toMatchObject({ forSaleCount: 1, fadedCount: 0 });
      });

      it("reports coverage, null before the first scan", async () => {
        expect((await listed("seller-a")).coverage).toBeNull();

        db.update(sellers)
          .set({ inventoryTotal: 14_320, scanCompletedAt: new Date() })
          .where(eq(sellers.username, "seller-a"))
          .run();
        const seller = db.select().from(sellers).where(eq(sellers.username, "seller-a")).get();
        db.insert(scanPasses)
          .values({
            runId: seller!.currentRunId!,
            sellerUsername: "seller-a",
            sort: "artist",
            order: "desc",
            status: "capped",
            pagesPlanned: 100,
            pagesFetched: 100,
            itemsSeen: 10_000,
            itemsNew: 10_000,
            startedAt: new Date(),
            endedAt: new Date(),
          })
          .run();
        for (const releaseId of [1, 2, 3]) {
          db.insert(sellerInventory)
            .values({
              sellerUsername: "seller-a",
              releaseId,
              status: "active",
              firstSeenAt: new Date(),
              lastSeenAt: new Date(),
              soldAt: null,
            })
            .run();
        }

        expect((await listed("seller-a")).coverage).toEqual({ reachable: 3, total: 14_320 });
      });
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
        ratingAverage: number | null;
        videos: { uri: string; title: string }[];
      }> = {},
    ) {
      db.insert(releases)
        .values({
          id,
          title,
          ratingAverage: overrides.ratingAverage ?? null,
          videos: overrides.videos ?? [],
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

    describe("listings", () => {
      const seedListing = (
        listingId: number,
        releaseId: number,
        price: number,
        currency = "USD",
        sleeveCondition: string | null = null,
      ) =>
        db
          .insert(sellerListings)
          .values({
            listingId,
            sellerUsername: "some-seller",
            releaseId,
            mediaCondition: "Near Mint (NM or M-)",
            sleeveCondition,
            price,
            currency,
            lastSeenAt: new Date(),
          })
          .run();

      it("lists every listing of each release, cheapest first within a currency", async () => {
        seedRelease(1, "Two copies");
        seedRelease(2, "No listings yet");
        seedInventoryRow(1, "active");
        seedInventoryRow(2, "active");
        seedListing(11, 1, 30, "USD", "Very Good (VG)");
        seedListing(12, 1, 8.5, "USD");
        seedListing(13, 1, 5, "EUR");
        seedListing(14, 3, 1);

        const res = await authedRequest(app).get("/sellers/some-seller/inventory");

        const byId = (id: number) => res.body.items.find((i: { releaseId: number }) => i.releaseId === id);
        expect(byId(1).listings).toEqual([
          { id: 13, mediaCondition: "Near Mint (NM or M-)", sleeveCondition: null, price: 5, currency: "EUR" },
          { id: 12, mediaCondition: "Near Mint (NM or M-)", sleeveCondition: null, price: 8.5, currency: "USD" },
          { id: 11, mediaCondition: "Near Mint (NM or M-)", sleeveCondition: "Very Good (VG)", price: 30, currency: "USD" },
        ]);
        expect(byId(2).listings).toEqual([]);
      });
    });

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

      const res = await authedRequest(app).get("/sellers/some-seller/inventory");
      expect(res.body.items).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    it("always excludes sold listings and returns only active ones", async () => {
      seedRelease(1, "Active Release");
      seedRelease(2, "Sold Release");
      seedInventoryRow(1, "active");
      seedInventoryRow(2, "sold");

      const res = await authedRequest(app).get("/sellers/some-seller/inventory");
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({ releaseId: 1, title: "Active Release", status: "active" });
      expect(res.body.total).toBe(1);
    });

    it("ignores a status query param — sold listings never come back", async () => {
      seedRelease(1, "Active Release");
      seedRelease(2, "Sold Release");
      seedInventoryRow(1, "active");
      seedInventoryRow(2, "sold");

      const res = await authedRequest(app).get("/sellers/some-seller/inventory?status=all");
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

      const res = await authedRequest(app).get("/sellers/some-seller/inventory?country=UK,US");
      expect(res.body.items.map((i: { releaseId: number }) => i.releaseId).sort()).toEqual([1, 2]);
    });

    it("paginates with page/pageSize", async () => {
      seedRelease(1, "R1");
      seedRelease(2, "R2");
      seedRelease(3, "R3");
      seedInventoryRow(1, "active");
      seedInventoryRow(2, "active");
      seedInventoryRow(3, "active");

      const res = await authedRequest(app).get("/sellers/some-seller/inventory?page=2&pageSize=2");
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

      const res = await authedRequest(app).get("/sellers/some-seller/inventory");
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

      const genreRes = await authedRequest(app).get("/sellers/some-seller/inventory?genre=Rock,Jazz");
      expect(genreRes.body.items.map((i: { releaseId: number }) => i.releaseId).sort()).toEqual([1, 2]);

      const formatRes = await authedRequest(app).get("/sellers/some-seller/inventory?format=Vinyl");
      expect(formatRes.body.items.map((i: { releaseId: number }) => i.releaseId)).toEqual([1]);
    });

    it("excludes releases matching excludeGenre, excludeStyle, or excludeFormat, combined with includes", async () => {
      seedRelease(1, "Minimal", { styles: ["Minimal"], genres: ["Electronic"], formats: [{ name: "Vinyl", descriptions: [] }] });
      seedRelease(2, "Minimal Ambient", { styles: ["Minimal", "Ambient"], genres: ["Electronic"], formats: [{ name: "CD", descriptions: [] }] });
      seedRelease(3, "Plain", { genres: ["Rock"] });
      seedInventoryRow(1, "active");
      seedInventoryRow(2, "active");
      seedInventoryRow(3, "active");
      const ids = (res: { body: { items: { releaseId: number }[] } }) => res.body.items.map((i) => i.releaseId).sort();

      const styleRes = await authedRequest(app).get("/sellers/some-seller/inventory?style=Minimal&excludeStyle=Ambient");
      expect(ids(styleRes)).toEqual([1]);
      expect(styleRes.body.total).toBe(1);

      const aloneRes = await authedRequest(app).get("/sellers/some-seller/inventory?excludeStyle=Ambient,Dub");
      expect(ids(aloneRes)).toEqual([1, 3]);

      const genreRes = await authedRequest(app).get("/sellers/some-seller/inventory?excludeGenre=Electronic");
      expect(ids(genreRes)).toEqual([3]);

      const formatRes = await authedRequest(app).get("/sellers/some-seller/inventory?excludeFormat=CD");
      expect(ids(formatRes)).toEqual([1, 3]);
    });

    it("filters by onlyGenre, onlyStyle, or onlyFormat: every value on the release must be in the list", async () => {
      seedRelease(1, "Pure", { genres: ["Electronic"], styles: ["Minimal"], formats: [{ name: "Vinyl", descriptions: [] }] });
      seedRelease(2, "Mixed", { genres: ["Electronic", "Rock"], styles: ["Minimal", "Ambient"], formats: [{ name: "Vinyl", descriptions: [] }, { name: "CD", descriptions: [] }] });
      seedRelease(3, "Untagged");
      seedInventoryRow(1, "active");
      seedInventoryRow(2, "active");
      seedInventoryRow(3, "active");
      const ids = (res: { body: { items: { releaseId: number }[] } }) => res.body.items.map((i) => i.releaseId).sort();

      const genreRes = await authedRequest(app).get("/sellers/some-seller/inventory?onlyGenre=Electronic");
      expect(ids(genreRes)).toEqual([1]);
      expect(genreRes.body.total).toBe(1);

      const multiRes = await authedRequest(app).get("/sellers/some-seller/inventory?onlyGenre=Electronic,Rock");
      expect(ids(multiRes)).toEqual([1, 2]);

      const styleRes = await authedRequest(app).get("/sellers/some-seller/inventory?onlyStyle=Minimal");
      expect(ids(styleRes)).toEqual([1]);

      const formatRes = await authedRequest(app).get("/sellers/some-seller/inventory?onlyFormat=Vinyl");
      expect(ids(formatRes)).toEqual([1]);
    });

    it("filters by noLinks: only keeps releases without video links, exclude drops them", async () => {
      seedRelease(1, "Linked", { videos: [{ uri: "https://youtube.com/x", title: "x" }] });
      seedRelease(2, "Bare");
      seedInventoryRow(1, "active");
      seedInventoryRow(2, "active");
      const ids = (res: { body: { items: { releaseId: number }[] } }) => res.body.items.map((i) => i.releaseId).sort();

      expect(ids(await authedRequest(app).get("/sellers/some-seller/inventory?noLinks=only"))).toEqual([2]);
      expect(ids(await authedRequest(app).get("/sellers/some-seller/inventory?noLinks=exclude"))).toEqual([1]);
      const bad = await authedRequest(app).get("/sellers/some-seller/inventory?noLinks=maybe");
      expect(bad.status).toBe(400);
    });

    it("filters by yearMin/yearMax", async () => {
      seedRelease(1, "Old", { year: 1980 });
      seedRelease(2, "Mid", { year: 2000 });
      seedRelease(3, "New", { year: 2020 });
      seedInventoryRow(1, "active");
      seedInventoryRow(2, "active");
      seedInventoryRow(3, "active");

      const res = await authedRequest(app).get("/sellers/some-seller/inventory?yearMin=1990&yearMax=2010");
      expect(res.body.items.map((i: { releaseId: number }) => i.releaseId)).toEqual([2]);
    });

    it("rejects an invalid sort value with 400", async () => {
      const res = await authedRequest(app).get("/sellers/some-seller/inventory?sort=bogus");
      expect(res.status).toBe(400);
    });

    it.each([
      ["-rating", [4.5, 3.2, null]],
      ["rating", [3.2, 4.5, null]],
    ])("sorts by %s with unrated releases last", async (sort, expected) => {
      seedRelease(1, "A", { ratingAverage: 3.2 });
      seedRelease(2, "B");
      seedRelease(3, "C", { ratingAverage: 4.5 });
      seedInventoryRow(1, "active");
      seedInventoryRow(2, "active");
      seedInventoryRow(3, "active");

      const res = await authedRequest(app).get(`/sellers/some-seller/inventory?sort=${sort}`);
      expect(res.body.items.map((i: { ratingAverage: number | null }) => i.ratingAverage)).toEqual(expected);
    });

    it("sorts by year descending and stays correct across pages", async () => {
      seedRelease(1, "A", { year: 1990 });
      seedRelease(2, "B", { year: 2010 });
      seedRelease(3, "C", { year: 2000 });
      seedInventoryRow(1, "active");
      seedInventoryRow(2, "active");
      seedInventoryRow(3, "active");

      const page1 = await authedRequest(app).get("/sellers/some-seller/inventory?sort=-year&page=1&pageSize=2");
      expect(page1.body.items.map((i: { year: number }) => i.year)).toEqual([2010, 2000]);

      const page2 = await authedRequest(app).get("/sellers/some-seller/inventory?sort=-year&page=2&pageSize=2");
      expect(page2.body.items.map((i: { year: number }) => i.year)).toEqual([1990]);
    });
  });

  describe("GET /sellers/:username/inventory/facets", () => {
    const now = new Date();
    const seedRelease = (
      id: number,
      overrides: Partial<{ country: string; genres: string[]; styles: string[]; formats: string[] }> = {},
    ) =>
      db
        .insert(releases)
        .values({
          id,
          title: `R${id}`,
          year: 2000,
          country: overrides.country ?? null,
          genres: overrides.genres ?? [],
          styles: overrides.styles ?? [],
          formats: (overrides.formats ?? []).map((name) => ({ name, descriptions: [] })),
          labelIds: [],
          artists: [],
        })
        .run();
    const seedInventory = (releaseId: number, status: "active" | "sold" = "active") =>
      db
        .insert(sellerInventory)
        .values({
          sellerUsername: "some-seller",
          releaseId,
          status,
          firstSeenAt: now,
          lastSeenAt: now,
          soldAt: status === "sold" ? now : null,
        })
        .run();
    const seedListing = (listingId: number, releaseId: number, price: number, currency = "EUR") =>
      db
        .insert(sellerListings)
        .values({
          listingId,
          sellerUsername: "some-seller",
          releaseId,
          mediaCondition: "Near Mint (NM or M-)",
          sleeveCondition: null,
          price,
          currency,
          lastSeenAt: now,
        })
        .run();
    const facets = (query = "") => authedRequest(app).get(`/sellers/some-seller/inventory/facets${query}`);

    it("counts the releases behind each genre, style, format and country of the for-sale inventory", async () => {
      seedRelease(1, { country: "UK", genres: ["Rock", "Pop"], styles: ["Prog Rock"], formats: ["Vinyl", "Vinyl"] });
      seedRelease(2, { country: "UK", genres: ["Rock"], styles: ["Indie Rock"], formats: ["CD"] });
      seedRelease(3, { country: "US", genres: ["Jazz"], styles: ["Bop"], formats: ["CD"] });
      seedInventory(1);
      seedInventory(2);
      seedInventory(3, "sold");

      const res = await facets();
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        genres: [
          { value: "Rock", count: 2 },
          { value: "Pop", count: 1 },
        ],
        styles: [
          { value: "Indie Rock", count: 1 },
          { value: "Prog Rock", count: 1 },
        ],
        formats: [
          { value: "CD", count: 1 },
          { value: "Vinyl", count: 1 },
        ],
        countries: [{ value: "UK", count: 2 }],
      });
    });

    it("counts only the releases matching the filters, like the inventory rows", async () => {
      seedRelease(1, { genres: ["Rock", "Pop"], styles: ["Prog Rock"] });
      seedRelease(2, { genres: ["Rock"], styles: ["Indie Rock"] });
      seedRelease(3, { genres: ["Jazz"], styles: ["Bop"] });
      [1, 2, 3].forEach((id) => seedInventory(id));

      const res = await facets("?genre=Pop");
      expect(res.body.genres).toEqual([
        { value: "Pop", count: 1 },
        { value: "Rock", count: 1 },
      ]);
      expect(res.body.styles).toEqual([{ value: "Prog Rock", count: 1 }]);
    });

    it("returns empty lists for a seller with no inventory", async () => {
      const res = await facets();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        genres: [],
        styles: [],
        formats: [],
        countries: [],
        currencies: [],
        currency: null,
        priceBuckets: [],
      });
    });

    it("rejects an invalid filter", async () => {
      expect((await facets("?priceMin=-1&currency=EUR")).status).toBe(400);
      expect((await facets("?priceMin=5")).status).toBe(400);
    });

    describe("price", () => {
      beforeEach(() => {
        // Ten releases, each with one EUR listing at 3, 6, 9 ... 30; release 1 also lists in USD.
        for (let id = 1; id <= 10; id++) {
          seedRelease(id, { genres: [id <= 5 ? "Techno" : "House"] });
          seedInventory(id);
          seedListing(id, id, id * 3);
        }
        seedListing(100, 1, 2000, "USD");
      });

      it("lists the currencies, most common first, and defaults to the first", async () => {
        const res = await facets();
        expect(res.body.currencies).toEqual([
          { currency: "EUR", count: 10 },
          { currency: "USD", count: 1 },
        ]);
        expect(res.body.currency).toBe("EUR");
      });

      it("offers up to six buckets with 1-2-5 boundaries that together hold every release", async () => {
        const { priceBuckets } = (await facets()).body as {
          priceBuckets: { min: number | null; max: number | null; count: number }[];
        };
        expect(priceBuckets.length).toBeGreaterThan(1);
        expect(priceBuckets.length).toBeLessThanOrEqual(6);
        expect(priceBuckets[0]!.min).toBeNull();
        expect(priceBuckets.at(-1)!.max).toBeNull();
        expect(priceBuckets.reduce((sum, b) => sum + b.count, 0)).toBe(10);
        for (const bucket of priceBuckets.slice(1)) expect([1, 2, 5]).toContain(Number(String(bucket.min)[0]));
      });

      it("makes a bucket's ends select exactly the releases it counts", async () => {
        const { priceBuckets } = (await facets()).body as {
          priceBuckets: { min: number | null; max: number | null; count: number }[];
        };
        for (const { min, max, count } of priceBuckets) {
          const params = new URLSearchParams({ currency: "EUR" });
          if (min !== null) params.set("priceMin", String(min));
          if (max !== null) params.set("priceMax", String(max));
          const res = await authedRequest(app).get(`/sellers/some-seller/inventory?${params}`);
          expect(res.body.total).toBe(count);
        }
      });

      it("uses the requested currency for the buckets", async () => {
        const res = await facets("?currency=USD");
        expect(res.body.currency).toBe("USD");
        expect(res.body.priceBuckets.reduce((sum: number, b: { count: number }) => sum + b.count, 0)).toBe(1);
      });

      it("narrows the counts to the price range but not the buckets", async () => {
        const res = await facets("?priceMin=3&priceMax=15&currency=EUR");
        expect(res.body.genres).toEqual([
          { value: "Techno", count: 5 },
        ]);
        expect(res.body.priceBuckets.reduce((sum: number, b: { count: number }) => sum + b.count, 0)).toBe(10);
      });

      it("narrows the buckets to the other filters", async () => {
        const res = await facets("?genre=House&currency=EUR");
        expect(res.body.priceBuckets.reduce((sum: number, b: { count: number }) => sum + b.count, 0)).toBe(5);
        expect(res.body.currencies[0]).toEqual({ currency: "EUR", count: 10 });
      });
    });
  });

  describe("GET /sellers/:username/inventory price filter", () => {
    it("matches a release when any of its listings is in range, in the given currency", async () => {
      const now = new Date();
      db.insert(releases)
        .values([1, 2].map((id) => ({ id, title: `R${id}`, year: 2000, genres: [], styles: [], formats: [], labelIds: [], artists: [] })))
        .run();
      db.insert(sellerInventory)
        .values(
          [1, 2].map((releaseId) => ({
            sellerUsername: "some-seller",
            releaseId,
            status: "active" as const,
            firstSeenAt: now,
            lastSeenAt: now,
            soldAt: null,
          })),
        )
        .run();
      db.insert(sellerListings)
        .values([
          { listingId: 1, releaseId: 1, price: 5, currency: "EUR" },
          { listingId: 2, releaseId: 1, price: 30, currency: "EUR" },
          { listingId: 3, releaseId: 2, price: 25, currency: "USD" },
        ].map((l) => ({ ...l, sellerUsername: "some-seller", mediaCondition: "Mint (M)", sleeveCondition: null, lastSeenAt: now })))
        .run();

      const ids = async (query: string) =>
        ((await authedRequest(app).get(`/sellers/some-seller/inventory?${query}`)).body.items as { releaseId: number }[]).map(
          (i) => i.releaseId,
        );

      expect(await ids("priceMin=20&priceMax=40&currency=EUR")).toEqual([1]);
      expect(await ids("priceMin=20&currency=USD")).toEqual([2]);
      expect(await ids("priceMax=4&currency=EUR")).toEqual([]);
      expect((await authedRequest(app).get("/sellers/some-seller/inventory?priceMax=4")).status).toBe(400);
    });
  });
});
