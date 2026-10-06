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
import { DiscogsTransientError } from "../discogs-client";
import { DiscogsQueue, PACING_MS } from "../queue/discogs-queue";
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
  };
}

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

    it("does not leave the seller running when enqueueing the first job fails", async () => {
      vi.spyOn(queue, "enqueue").mockImplementation(() => {
        throw new Error("disk full");
      });

      const res = await authedRequest(app).post("/sellers/some-seller/index").send();

      expect(res.status).toBe(500);
      expect(db.select().from(sellers).where(eq(sellers.username, "some-seller")).all()).toEqual([]);
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
      }> = {},
    ) {
      db.insert(releases)
        .values({
          id,
          title,
          ratingAverage: overrides.ratingAverage ?? null,
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

      const res = await authedRequest(app).get("/sellers/some-seller/inventory/facets");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        genres: ["Pop", "Rock"],
        styles: ["Indie Rock", "Prog Rock"],
        formats: ["CD", "Vinyl"],
        countries: ["UK", "US"],
      });
    });

    it("returns empty arrays for a seller with no inventory", async () => {
      const res = await authedRequest(app).get("/sellers/unknown-seller/inventory/facets");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ genres: [], styles: [], formats: [], countries: [] });
    });
  });
});
