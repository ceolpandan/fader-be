import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Express } from "express";
import { createDb, type Db } from "../db/client";
import { discogsQueueJobs, discogsTokens, enrichmentNotFound, enrichmentRuns, fades, releases } from "../db/schema";
import { DiscogsAuthError } from "../discogs-client";
import { failRun, finishRunWhenSettled } from "../enrichment/enrichment-run";
import { DiscogsQueue } from "../queue/discogs-queue";
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

describe("enrichment routes", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;
  let app: Express;
  let uid: string;

  const auth = { Authorization: "Bearer test-token" };
  const get = (url: string) => request(app).get(url).set(auth);
  const post = (url: string, body?: object) => request(app).post(url).set(auth).send(body);

  const seed = (id: number, overrides: Partial<typeof releases.$inferInsert> = {}) =>
    db
      .insert(releases)
      .values({ id, title: `R${id}`, genres: ["Electronic"], styles: [], formats: [], artists: [], ...overrides })
      .run();
  const addToken = (forUid = "u1") =>
    db.insert(discogsTokens).values({ uid: forUid, tokenEncrypted: "x", username: "dan", createdAt: new Date() }).run();
  const jobs = () => db.select().from(discogsQueueJobs).all();
  const releaseIdsQueued = () => jobs().map((job) => (job.payload as { releaseId: number }).releaseId);

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    queue = new DiscogsQueue(db);
    app = createApp({ db, queue });
    uid = "u1";

    process.env.FIREBASE_PROJECT_ID = "test-project";
    process.env.FIREBASE_CLIENT_EMAIL = "test@test-project.iam.gserviceaccount.com";
    process.env.FIREBASE_PRIVATE_KEY = "test-key";
    process.env.ALLOWED_EMAILS = "dp.ceolpan@gmail.com";
    delete process.env.ENRICH_MAX_RELEASES;
    verifyIdToken.mockReset();
    verifyIdToken.mockImplementation(async () => ({ uid, email: "dp.ceolpan@gmail.com" }));
  });

  afterEach(() => {
    queue.stop();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
    delete process.env.ENRICH_MAX_RELEASES;
  });

  describe("POST /enrichment/run", () => {
    it("needs a Discogs token and queues nothing without one", async () => {
      seed(1);

      const res = await post("/enrichment/run", { query: "" });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("token_required");
      expect(jobs()).toEqual([]);
    });

    it("queues the releases the filter shows that were never enriched", async () => {
      addToken();
      seed(1);
      seed(2, { enrichedAt: new Date(1) });
      seed(3, { missingAt: new Date(1) });
      seed(4, { genres: ["Rock"] });

      const res = await post("/enrichment/run", { query: "genre=Electronic&sort=-rating" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: "running", total: 1, skipped: 1, remaining: 1, enriched: 0, fresh: false });
      expect(releaseIdsQueued()).toEqual([1]);
      expect(jobs()[0]).toMatchObject({ uid: "u1", type: "release_detail", runId: res.body.id, priority: 0 });
    });

    it("re-fetches enriched and missing releases on a fresh run", async () => {
      addToken();
      seed(1);
      seed(2, { enrichedAt: new Date(1) });
      seed(3, { missingAt: new Date(1) });

      const res = await post("/enrichment/run", { query: "", fresh: true });

      expect(res.body).toMatchObject({ total: 3, skipped: 0, fresh: true });
      expect(releaseIdsQueued()).toEqual([1, 2, 3]);
    });

    it("skips releases the collector faded, directly or through the master", async () => {
      addToken();
      seed(1);
      seed(2, { masterId: 50 });
      seed(3);
      db.insert(fades).values({ uid: "u1", kind: "release", id: 1, createdAt: new Date() }).run();
      db.insert(fades).values({ uid: "u1", kind: "master", id: 50, createdAt: new Date() }).run();

      const res = await post("/enrichment/run", { query: "" });

      expect(releaseIdsQueued()).toEqual([3]);
      expect(res.body.total).toBe(1);
    });

    it("queues a release only once across collectors", async () => {
      addToken("u1");
      addToken("u2");
      seed(1);
      seed(2);
      await post("/enrichment/run", { query: "" });
      uid = "u2";

      const res = await post("/enrichment/run", { query: "" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ total: 0, skipped: 2, status: "done" });
      expect(jobs()).toHaveLength(2);
    });

    it("adds the releases of a second filter to the active run", async () => {
      addToken();
      seed(1);
      const first = await post("/enrichment/run", { query: "" });
      seed(2);

      const res = await post("/enrichment/run", { query: "" });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe(first.body.id);
      expect(res.body).toMatchObject({ status: "running", total: 2, remaining: 2 });
      expect(releaseIdsQueued()).toEqual([1, 2]);
    });

    it("leaves the active run as it is when the second filter has nothing new", async () => {
      addToken();
      seed(1);
      const first = await post("/enrichment/run", { query: "" });

      const res = await post("/enrichment/run", { query: "" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ id: first.body.id, total: 1 });
      expect(jobs()).toHaveLength(1);
    });

    it("refuses a run above the cap, counting only the releases it would enrich", async () => {
      addToken();
      process.env.ENRICH_MAX_RELEASES = "2";
      seed(1);
      seed(2);
      seed(3, { enrichedAt: new Date(1) });
      expect((await post("/enrichment/run", { query: "" })).status).toBe(201);
      await post("/enrichment/run/cancel");
      db.delete(discogsQueueJobs).run();
      seed(4);

      const res = await post("/enrichment/run", { query: "" });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("too_many_releases");
      expect(jobs()).toEqual([]);
    });

    it("rejects an invalid filter", async () => {
      addToken();

      expect((await post("/enrichment/run", { query: "tracks=99" })).status).toBe(400);
      expect((await post("/enrichment/run", { query: "", fresh: "yes" })).status).toBe(400);
    });
  });

  describe("GET /enrichment/preview", () => {
    it("counts what a run would fetch and leave alone, and reports the cap", async () => {
      process.env.ENRICH_MAX_RELEASES = "5";
      seed(1);
      seed(2, { enrichedAt: new Date(1) });

      const res = await get("/enrichment/preview?query=" + encodeURIComponent("genre=Electronic"));
      expect(res.body).toEqual({ count: 1, skipped: 1, max: 5 });

      const fresh = await get("/enrichment/preview?fresh=true");
      expect(fresh.body).toEqual({ count: 2, skipped: 0, max: 5 });
    });

    it("has no cap outside production unless configured", async () => {
      expect((await get("/enrichment/preview")).body.max).toBeNull();
    });
  });

  describe("run status", () => {
    it("is empty before any run", async () => {
      expect((await get("/enrichment/run")).body).toEqual({ run: null });
    });

    it("counts enriched, not found and failed releases, and is done once the last job settles", async () => {
      addToken();
      for (const id of [1, 2, 3, 4]) seed(id);
      const started = await post("/enrichment/run", { query: "" });
      const runId = started.body.id as string;
      const [a, b, c, d] = jobs();
      const set = (id: number, status: "done" | "failed") =>
        db.update(discogsQueueJobs).set({ status }).where(eq(discogsQueueJobs.id, id)).run();
      set(a!.id, "done");
      set(b!.id, "failed");
      db.insert(enrichmentNotFound).values({ runId, releaseId: 2 }).run();
      set(c!.id, "failed");
      finishRunWhenSettled(db, { type: "release_detail", runId });
      expect((await get("/enrichment/run")).body.run).toMatchObject({ status: "running", remaining: 1 });

      set(d!.id, "done");
      finishRunWhenSettled(db, { type: "release_detail", runId });

      const { run } = (await get("/enrichment/run")).body;
      expect(run).toMatchObject({ status: "done", total: 4, enriched: 2, notFound: 1, failed: 1, remaining: 0 });
      expect(run.finishedAt).not.toBeNull();
      expect(run.notFoundReleases).toEqual([{ releaseId: 2, title: "R2", artists: [] }]);
    });

    it("fails the run when Discogs rejects the token", async () => {
      addToken();
      seed(1);
      const { body } = await post("/enrichment/run", { query: "" });

      failRun(db, body.id, new DiscogsAuthError("401"));

      expect((await get("/enrichment/run")).body.run).toMatchObject({
        status: "failed",
        errorMessage: "Discogs rejected your token",
      });
    });

    it("keeps only the last run, and shows each collector their own", async () => {
      addToken("u1");
      addToken("u2");
      seed(1);
      const first = await post("/enrichment/run", { query: "" });
      await post("/enrichment/run/cancel");
      const second = await post("/enrichment/run", { query: "genre=Electronic" });
      uid = "u2";

      expect((await get("/enrichment/run")).body).toEqual({ run: null });
      uid = "u1";
      expect((await get("/enrichment/run")).body.run.id).toBe(second.body.id);
      expect(db.select().from(enrichmentRuns).all().map((run) => run.id)).toEqual([second.body.id]);
      expect(jobs().every((job) => job.runId === second.body.id)).toBe(true);
      expect(first.body.id).not.toBe(second.body.id);
    });
  });

  describe("POST /enrichment/run/cancel", () => {
    it("drops the queued jobs and ends the run", async () => {
      addToken();
      seed(1);
      seed(2);
      seed(3);
      await post("/enrichment/run", { query: "" });
      const [first] = jobs();
      db.update(discogsQueueJobs).set({ status: "done" }).where(eq(discogsQueueJobs.id, first!.id)).run();

      const res = await post("/enrichment/run/cancel");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "cancelled", total: 1, enriched: 1, remaining: 0 });
      expect(jobs()).toHaveLength(1);
      expect((await post("/enrichment/run", { query: "" })).status).toBe(201);
    });

    it("answers 409 when no run is active", async () => {
      const res = await post("/enrichment/run/cancel");

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("no_active_run");
    });
  });
});
