import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import request from "supertest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Express } from "express";
import { createDb, type Db } from "../db/client";
import { discogsProfiles, discogsQueueJobs, discogsTokens, hiddenReleases } from "../db/schema";
import { DiscogsAuthError, DiscogsTransientError } from "../discogs-client";
import { getDiscogsToken } from "../db/discogs-tokens";
import { createDiscogsProfileHandler } from "../indexing/discogs-profile-handler";
import { createDiscogsSyncHandler } from "../indexing/discogs-sync-handler";
import { DiscogsQueue } from "../queue/discogs-queue";
import type { DiscogsListItem } from "../types/discogs-api";
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

function asUser(app: Express, uid: string) {
  verifyIdToken.mockResolvedValue({ uid, email: "dp.ceolpan@gmail.com" });
  const agent = request(app);
  const auth = { Authorization: "Bearer test-token" };
  return {
    get: (url: string) => agent.get(url).set(auth),
    put: (url: string) => agent.put(url).set(auth),
    post: (url: string) => agent.post(url).set(auth),
    delete: (url: string) => agent.delete(url).set(auth),
  };
}

function item(id: number, masterId = 0): DiscogsListItem {
  return { id, basic_information: { id, master_id: masterId, title: `Title ${id}`, artists: [] } };
}

const idle = { status: "idle", error: null };

describe("discogs profile", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;
  let app: Express;
  let getCollectionCount: Mock<(username: string, token: string) => Promise<number>>;
  let getWantlistCount: Mock<(username: string, token: string) => Promise<number>>;
  let getWantlistPage: Mock;
  let getCollectionPage: Mock;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    queue = new DiscogsQueue(db);
    getCollectionCount = vi.fn(async () => 120);
    getWantlistCount = vi.fn(async () => 7);
    getWantlistPage = vi.fn(async () => ({ pagination: { pages: 1 }, wants: [item(1, 100), item(2)] }));
    getCollectionPage = vi.fn(async () => ({ pagination: { pages: 1 }, releases: [item(3, 200)] }));
    queue.registerHandler(
      "discogs_profile",
      createDiscogsProfileHandler({
        db,
        getToken: (uid) => getDiscogsToken(db, uid),
        getCollectionCount,
        getWantlistCount,
        sleep: async () => {},
      }),
    );
    queue.registerHandler(
      "discogs_sync",
      createDiscogsSyncHandler({
        db,
        enqueue: (job) => queue.enqueue(job),
        getToken: (uid) => getDiscogsToken(db, uid),
        getWantlistPage,
        getCollectionPage,
        sleep: async () => {},
      }),
    );
    queue.start();
    app = createApp({ db, queue, getIdentity: async () => ({ id: 1, username: "dan" }) });

    process.env.FIREBASE_PROJECT_ID = "test-project";
    process.env.FIREBASE_CLIENT_EMAIL = "test@test-project.iam.gserviceaccount.com";
    process.env.FIREBASE_PRIVATE_KEY = "test-key";
    process.env.ALLOWED_EMAILS = "dp.ceolpan@gmail.com";
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    verifyIdToken.mockReset();
  });

  afterEach(() => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    queue.stop();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  const saveToken = (uid: string, token = "abc123") =>
    asUser(app, uid).put("/settings/discogs-token").send({ token });

  /** Waits until the collector's sync job has run to its end (done or failed); a second job waits out the lane's pacing. */
  const syncSettled = (uid: string) =>
    vi.waitFor(
      async () => {
        const res = await asUser(app, uid).get("/me/discogs-profile");
        expect(res.body.sync.status).not.toBe("running");
        return res.body;
      },
      { timeout: 5000 },
    );

  it("requires a signed-in user", async () => {
    expect((await request(app).get("/me/discogs-profile")).status).toBe(401);
    expect((await request(app).post("/me/discogs-profile/counts")).status).toBe(401);
    expect((await request(app).post("/me/discogs-profile/refresh")).status).toBe(401);
  });

  describe("GET", () => {
    it("reports no token and no profile to a collector with neither", async () => {
      const res = await asUser(app, "u1").get("/me/discogs-profile");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ tokenSet: false, profile: null, sync: idle });
    });

    it("reports a token with no profile until the first fetch, and fetches nothing", async () => {
      await saveToken("u1");

      const res = await asUser(app, "u1").get("/me/discogs-profile");

      expect(res.body).toEqual({ tokenSet: true, profile: null, sync: idle });
      expect(getCollectionCount).not.toHaveBeenCalled();
      expect(getWantlistPage).not.toHaveBeenCalled();
    });
  });

  describe("POST /counts", () => {
    it("fetches with the saved token, caches the counts, and has not synced", async () => {
      await saveToken("u1", "abc123");

      const res = await asUser(app, "u1").post("/me/discogs-profile/counts");

      expect(res.status).toBe(200);
      expect(getCollectionCount).toHaveBeenCalledWith("dan", "abc123");
      expect(getWantlistCount).toHaveBeenCalledWith("dan", "abc123");
      expect(res.body).toMatchObject({
        tokenSet: true,
        profile: { username: "dan", collectionCount: 120, wantlistCount: 7, lastSyncedAt: null },
        sync: idle,
      });
      expect(Number.isNaN(Date.parse(res.body.profile.fetchedAt))).toBe(false);
      expect(getWantlistPage).not.toHaveBeenCalled();

      const read = await asUser(app, "u1").get("/me/discogs-profile");
      expect(read.body).toEqual(res.body);
      expect(JSON.stringify(res.body)).not.toContain("abc123");
    });

    it("replaces the cached counts on a second fetch", async () => {
      await saveToken("u1");
      await asUser(app, "u1").post("/me/discogs-profile/counts");
      getCollectionCount.mockResolvedValue(121);
      getWantlistCount.mockResolvedValue(6);

      const res = await asUser(app, "u1").post("/me/discogs-profile/counts");

      expect(res.body.profile).toMatchObject({ collectionCount: 121, wantlistCount: 6 });
      expect(db.select().from(discogsProfiles).all()).toHaveLength(1);
    });

    it("keeps the time of the last sync", async () => {
      await saveToken("u1");
      await asUser(app, "u1").post("/me/discogs-profile/refresh");
      const synced = await syncSettled("u1");

      const res = await asUser(app, "u1").post("/me/discogs-profile/counts");

      expect(res.body.profile.lastSyncedAt).toBe(synced.profile.lastSyncedAt);
    });

    it("answers 409 without a token, without asking Discogs", async () => {
      const res = await asUser(app, "u1").post("/me/discogs-profile/counts");

      expect(res.status).toBe(409);
      expect(getCollectionCount).not.toHaveBeenCalled();
    });

    it("answers 400, not 401, when Discogs rejects the token, and keeps the cached profile", async () => {
      await saveToken("u1");
      await asUser(app, "u1").post("/me/discogs-profile/counts");
      getCollectionCount.mockRejectedValue(new DiscogsAuthError("revoked"));

      const res = await asUser(app, "u1").post("/me/discogs-profile/counts");

      expect(res.status).toBe(400);
      const read = await asUser(app, "u1").get("/me/discogs-profile");
      expect(read.body.profile).toMatchObject({ collectionCount: 120 });
    });

    it("answers 503 when Discogs is erroring, and caches nothing", async () => {
      await saveToken("u1");
      getCollectionCount.mockRejectedValue(new DiscogsTransientError("down"));

      const res = await asUser(app, "u1").post("/me/discogs-profile/counts");

      expect(res.status).toBe(503);
      expect(db.select().from(discogsProfiles).all()).toEqual([]);
    });

    it("goes through the queue, ahead of enrichment jobs that are waiting", async () => {
      const order: string[] = [];
      queue.registerHandler("release_detail", async ({ releaseId }) => {
        order.push(`release ${releaseId}`);
      });
      getCollectionCount.mockImplementation(async () => {
        order.push("profile");
        return 120;
      });
      await saveToken("u1");
      for (const releaseId of [1, 2, 3]) {
        queue.enqueue({ runId: "run1", type: "release_detail", payload: { uid: "u1", releaseId } });
      }
      // The first release is processed; the lane then paces the rest.
      await vi.waitFor(() => expect(order).toEqual(["release 1"]));

      const res = await asUser(app, "u1").post("/me/discogs-profile/counts");

      expect(res.status).toBe(200);
      expect(order).toEqual(["release 1", "profile"]);
    });
  });

  describe("POST /refresh", () => {
    it("answers 409 without a token, without asking Discogs", async () => {
      const res = await asUser(app, "u1").post("/me/discogs-profile/refresh");

      expect(res.status).toBe(409);
      expect(db.select().from(discogsQueueJobs).all()).toEqual([]);
    });

    it("starts the sync at once and answers 202 with it running", async () => {
      await saveToken("u1");
      queue.stop();

      const res = await asUser(app, "u1").post("/me/discogs-profile/refresh");

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ tokenSet: true, profile: null, sync: { status: "running", error: null } });
      const [job] = db.select().from(discogsQueueJobs).all();
      expect(job).toMatchObject({ type: "discogs_sync", uid: "u1", priority: 5, status: "pending" });
    });

    it("syncs the lists with the saved token, then reports the counts and the sync time", async () => {
      await saveToken("u1", "abc123");

      await asUser(app, "u1").post("/me/discogs-profile/refresh");
      const body = await syncSettled("u1");

      expect(getWantlistPage).toHaveBeenCalledWith("dan", 1, "abc123");
      expect(getCollectionPage).toHaveBeenCalledWith("dan", 1, "abc123");
      expect(body).toMatchObject({
        tokenSet: true,
        profile: { username: "dan", collectionCount: 1, wantlistCount: 2 },
        sync: idle,
      });
      expect(Number.isNaN(Date.parse(body.profile.lastSyncedAt))).toBe(false);
      expect(db.select().from(hiddenReleases).all()).toHaveLength(3);
    });

    it("does not start a second sync while one is queued or running", async () => {
      await saveToken("u1");
      queue.stop();

      await asUser(app, "u1").post("/me/discogs-profile/refresh");
      const res = await asUser(app, "u1").post("/me/discogs-profile/refresh");

      expect(res.status).toBe(202);
      expect(db.select().from(discogsQueueJobs).all()).toHaveLength(1);
    });

    it("starts another sync once the last one is over", async () => {
      await saveToken("u1");
      await asUser(app, "u1").post("/me/discogs-profile/refresh");
      await syncSettled("u1");
      getWantlistPage.mockClear();

      await asUser(app, "u1").post("/me/discogs-profile/refresh");
      await syncSettled("u1");

      expect(getWantlistPage).toHaveBeenCalledTimes(1);
    });

    it("reports a failed sync with the reason, and keeps the previous data", async () => {
      await saveToken("u1");
      await asUser(app, "u1").post("/me/discogs-profile/refresh");
      await syncSettled("u1");
      getWantlistPage.mockRejectedValue(new DiscogsAuthError("Discogs refused our token (401) for /x: revoked"));

      await asUser(app, "u1").post("/me/discogs-profile/refresh");
      const body = await syncSettled("u1");

      expect(body.sync).toEqual({ status: "failed", error: "Discogs did not accept your token. Update it in Settings." });
      expect(body.profile).toMatchObject({ collectionCount: 1, wantlistCount: 2 });
      expect(db.select().from(hiddenReleases).all()).toHaveLength(3);
    });

    it("reports the failure until the next sync starts", async () => {
      await saveToken("u1");
      getWantlistPage.mockRejectedValue(new DiscogsAuthError("Discogs refused our token (401) for /x: revoked"));
      await asUser(app, "u1").post("/me/discogs-profile/refresh");
      await syncSettled("u1");

      expect((await asUser(app, "u1").get("/me/discogs-profile")).body.sync.status).toBe("failed");

      queue.stop();
      const res = await asUser(app, "u1").post("/me/discogs-profile/refresh");
      expect(res.body.sync).toEqual({ status: "running", error: null });
    });

    it("does not report a failure from before the token was replaced", async () => {
      await saveToken("u1", "old");
      getWantlistPage.mockRejectedValue(new DiscogsAuthError("Discogs refused our token (401) for /x: revoked"));
      await asUser(app, "u1").post("/me/discogs-profile/refresh");
      await syncSettled("u1");
      // Jobs and tokens are stamped to the second; the failed job is older than the new token.
      db.update(discogsQueueJobs).set({ createdAt: new Date(Date.now() - 60_000) }).run();

      await saveToken("u1", "new");

      expect((await asUser(app, "u1").get("/me/discogs-profile")).body.sync).toEqual(idle);
    });

    it("keeps each collector's profile and sync separate", async () => {
      await saveToken("u1");
      await asUser(app, "u1").post("/me/discogs-profile/refresh");
      await syncSettled("u1");

      const res = await asUser(app, "u2").get("/me/discogs-profile");

      expect(res.body).toEqual({ tokenSet: false, profile: null, sync: idle });
    });

    it("runs behind a fade a person is waiting on, but ahead of enrichment", async () => {
      const order: string[] = [];
      queue.stop();
      queue.registerHandler("release_detail", async () => {
        order.push("enrichment");
      });
      queue.registerHandler("fade_lookup", async () => {
        order.push("inline fade");
      });
      getWantlistPage.mockImplementation(async () => {
        order.push("sync");
        return { pagination: { pages: 1 }, wants: [] };
      });
      getCollectionPage.mockResolvedValue({ pagination: { pages: 1 }, releases: [] });
      await saveToken("u1");
      queue.enqueue({ runId: "e", type: "release_detail", payload: { uid: "u1", releaseId: 1 } });
      await asUser(app, "u1").post("/me/discogs-profile/refresh");
      queue.enqueue({ runId: "f", type: "fade_lookup", payload: { uid: "u1", kind: "release", id: 5 }, priority: 10 });

      queue.start();

      await vi.waitFor(() => expect(order).toEqual(["inline fade", "sync", "enrichment"]), { timeout: 6000 });
    }, 10_000);
  });

  describe("when the token changes", () => {
    it("drops the cached profile when the token is removed", async () => {
      await saveToken("u1");
      await asUser(app, "u1").post("/me/discogs-profile/counts");

      await asUser(app, "u1").delete("/settings/discogs-token");

      const res = await asUser(app, "u1").get("/me/discogs-profile");
      expect(res.body).toEqual({ tokenSet: false, profile: null, sync: idle });
    });

    it("drops the cached profile, and with it the sync time, when the token is replaced", async () => {
      await saveToken("u1", "first");
      await asUser(app, "u1").post("/me/discogs-profile/refresh");
      await syncSettled("u1");

      await saveToken("u1", "second");

      const res = await asUser(app, "u1").get("/me/discogs-profile");
      expect(res.body).toEqual({ tokenSet: true, profile: null, sync: idle });
      expect(db.select().from(discogsTokens).all()).toHaveLength(1);
    });

    it("leaves another collector's profile alone", async () => {
      await saveToken("u1");
      await saveToken("u2");
      await asUser(app, "u2").post("/me/discogs-profile/counts");

      await asUser(app, "u1").delete("/settings/discogs-token");

      const res = await asUser(app, "u2").get("/me/discogs-profile");
      expect(res.body.profile).not.toBeNull();
    });
  });
});
