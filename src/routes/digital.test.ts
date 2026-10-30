import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import request from "supertest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { digitalMatches, releases, wantlistItems } from "../db/schema";
import { DiscogsQueue } from "../queue/discogs-queue";
import { createApp } from "../app";
import { CHECK_PRIORITY, PacedLane } from "../digital/paced-lane";
import { StoreSessions } from "../digital/store-sessions";
import type { DigitalStores } from "../digital/digital-stores";
import {
  StoreSessionExpiredError,
  StoreUnavailableError,
  type DigitalStore,
  type StoreHit,
} from "../digital/types";

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
  const auth = { Authorization: "Bearer test-token" };
  return {
    get: (url: string) => request(app).get(url).set(auth),
    put: (url: string) => request(app).put(url).set(auth),
    post: (url: string) => request(app).post(url).set(auth),
  };
}

const CURL = `curl 'https://bandcamp.com/search?q=a&item_type=t' -H 'accept: text/html' -b 'cart_client_id=1; identity=secret'`;

const albumHit: StoreHit = {
  kind: "album",
  title: "Permutation",
  artist: "VC-118A",
  album: null,
  url: "https://chaindata.bandcamp.com/album/permutation",
};

describe("digital matches", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;
  let app: Express;
  let sessions: StoreSessions;
  let lane: PacedLane;
  let searchReleases: Mock<NonNullable<DigitalStore["searchReleases"]>>;
  let searchTracks: Mock<NonNullable<DigitalStore["searchTracks"]>>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    queue = new DiscogsQueue(db);

    searchReleases = vi.fn(async () => [albumHit]);
    searchTracks = vi.fn(async () => []);
    const store: DigitalStore = {
      id: "bandcamp",
      searchReleases: (...args) => searchReleases(...args),
      searchTracks: (...args) => searchTracks(...args),
    };
    sessions = new StoreSessions();
    lane = new PacedLane(0);
    const digital: DigitalStores = {
      stores: { bandcamp: { store, lane, host: "bandcamp.com" } },
      sessions,
    };
    app = createApp({ db, queue, digital });

    process.env.FIREBASE_PROJECT_ID = "test-project";
    process.env.FIREBASE_CLIENT_EMAIL = "test@test-project.iam.gserviceaccount.com";
    process.env.FIREBASE_PRIVATE_KEY = "test-key";
    process.env.ALLOWED_EMAILS = "dp.ceolpan@gmail.com";
    verifyIdToken.mockReset();

    db.insert(releases)
      .values({
        id: 1,
        title: "Permutation",
        videos: [],
        tracklist: [{ position: "A1", title: "Enter" }],
        year: 2018,
        genres: [],
        styles: [],
        formats: [],
        labels: [],
        artists: [{ id: 1, name: "VC-118A" }],
        masterId: null,
      })
      .run();
    db.insert(wantlistItems)
      .values({ uid: "u1", releaseId: 1, masterId: null, title: "Permutation", artists: [{ id: 1, name: "VC-118A" }], addedAt: null })
      .run();
    db.insert(wantlistItems)
      .values({ uid: "u1", releaseId: 900, masterId: null, title: "Not stored", artists: [{ id: 2, name: "X" }], addedAt: null })
      .run();
    db.insert(wantlistItems)
      .values({ uid: "u2", releaseId: 1, masterId: null, title: "Permutation", artists: [{ id: 1, name: "VC-118A" }], addedAt: null })
      .run();
  });

  afterEach(() => {
    queue.stop();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  describe("PUT /digital/:store/session", () => {
    it("requires a signed-in user", async () => {
      expect((await request(app).put("/digital/bandcamp/session")).status).toBe(401);
    });

    it("keeps the session without the login cookies and says when it expires", async () => {
      const res = await asUser(app, "u1").put("/digital/bandcamp/session").send({ curl: CURL });

      expect(res.status).toBe(200);
      expect(res.body.store).toBe("bandcamp");
      expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(sessions.get("u1", "bandcamp")?.headers["cookie"]).toBe("cart_client_id=1");
      expect(sessions.get("u2", "bandcamp")).toBeNull();
    });

    it("rejects a curl that cannot be used", async () => {
      const notCurl = await asUser(app, "u1").put("/digital/bandcamp/session").send({ curl: "hello" });
      const otherSite = await asUser(app, "u1")
        .put("/digital/bandcamp/session")
        .send({ curl: "curl 'https://example.com/' -H 'accept: */*'" });
      const missing = await asUser(app, "u1").put("/digital/bandcamp/session").send({});

      expect(notCurl.status).toBe(400);
      expect(otherSite.status).toBe(400);
      expect(missing.status).toBe(400);
    });

    it("answers 404 for an unknown store", async () => {
      expect((await asUser(app, "u1").put("/digital/beatport/session").send({ curl: CURL })).status).toBe(404);
    });
  });

  describe("POST /digital/:store/matches", () => {
    const check = (releaseId: unknown, uid = "u1") =>
      asUser(app, uid).post("/digital/bandcamp/matches").send({ releaseId });

    it("asks for a fresh curl when none was pasted", async () => {
      const res = await check(1);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("store_session_required");
      expect(searchReleases).not.toHaveBeenCalled();
    });

    it("stores an album match and answers with it", async () => {
      sessions.set("u1", "bandcamp", { headers: {} });
      const res = await check(1);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        store: "bandcamp",
        status: "album",
        url: "https://chaindata.bandcamp.com/album/permutation",
        tracks: [],
      });
      const row = db.select().from(digitalMatches).where(eq(digitalMatches.releaseId, 1)).get();
      expect(row).toMatchObject({ store: "bandcamp", status: "album", url: albumHit.url });
    });

    it("stores the tracks that were found when the album is not", async () => {
      sessions.set("u1", "bandcamp", { headers: {} });
      searchReleases.mockResolvedValue([]);
      searchTracks.mockResolvedValue([
        { kind: "track", title: "Enter", artist: "VC-118A", album: "Permutation", url: "https://a.bandcamp.com/track/enter" },
      ]);
      const res = await check(1);

      expect(res.body).toMatchObject({
        status: "tracks",
        url: null,
        tracks: [{ position: "A1", title: "Enter", url: "https://a.bandcamp.com/track/enter" }],
        trackCount: 1,
      });
    });

    it("stores none, and a recheck replaces the earlier result", async () => {
      sessions.set("u1", "bandcamp", { headers: {} });
      searchReleases.mockResolvedValue([]);
      expect((await check(1)).body.status).toBe("none");

      searchReleases.mockResolvedValue([albumHit]);
      expect((await check(1)).body.status).toBe("album");
      expect(db.select().from(digitalMatches).all()).toHaveLength(1);
    });

    it("forgets a session the store refused and asks for a fresh curl", async () => {
      sessions.set("u1", "bandcamp", { headers: {} });
      searchReleases.mockRejectedValue(new StoreSessionExpiredError());
      const res = await check(1);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("store_session_required");
      expect(sessions.get("u1", "bandcamp")).toBeNull();
      expect(db.select().from(digitalMatches).all()).toHaveLength(0);
    });

    it("answers 503 and stores nothing when the store is unavailable", async () => {
      sessions.set("u1", "bandcamp", { headers: {} });
      searchReleases.mockRejectedValue(new StoreUnavailableError());
      const res = await check(1);

      expect(res.status).toBe(503);
      expect(sessions.get("u1", "bandcamp")).not.toBeNull();
      expect(db.select().from(digitalMatches).all()).toHaveLength(0);
    });

    it("refuses a release that is not on the collector's wantlist", async () => {
      sessions.set("u1", "bandcamp", { headers: {} });
      expect((await check(2)).status).toBe(404);
      expect((await check(1, "u3")).status).toBe(404);
    });

    it("refuses a wantlist item whose release is not stored yet", async () => {
      sessions.set("u1", "bandcamp", { headers: {} });
      expect((await check(900)).status).toBe(409);
      expect(searchReleases).not.toHaveBeenCalled();
    });

    it("rejects an invalid releaseId and an unknown store", async () => {
      expect((await check("1")).status).toBe(400);
      expect((await check(0)).status).toBe(400);
      expect((await asUser(app, "u1").post("/digital/beatport/matches").send({ releaseId: 1 })).status).toBe(404);
    });

    it("goes ahead of a scan's requests on the store's lane", async () => {
      sessions.set("u1", "bandcamp", { headers: {} });
      const run = vi.spyOn(lane, "run");

      await asUser(app, "u1").post("/digital/bandcamp/matches").send({ releaseId: 1 });

      expect(run).toHaveBeenCalledWith(expect.any(Function), CHECK_PRIORITY);
    });
  });

  describe("scanning the wantlist", () => {
    const untilScan = (status: string) =>
      vi.waitFor(async () => {
        const res = await asUser(app, "u1").get("/digital/bandcamp/scan");
        expect(res.body.scan?.status).toBe(status);
      });

    it("requires a signed-in user", async () => {
      expect((await request(app).post("/digital/bandcamp/scan")).status).toBe(401);
    });

    it("has no scan until one is started", async () => {
      const res = await asUser(app, "u1").get("/digital/bandcamp/scan");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ scan: null });
    });

    it("asks for a fresh curl when there is none", async () => {
      const res = await asUser(app, "u1").post("/digital/bandcamp/scan").send({});
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("store_session_required");
    });

    it("scans the wantlist and reports the progress", async () => {
      sessions.set("u1", "bandcamp", { headers: {} });

      const started = await asUser(app, "u1").post("/digital/bandcamp/scan").send({});
      expect(started.status).toBe(201);
      expect(started.body).toMatchObject({ store: "bandcamp", recheck: false, total: 1, skipped: 1 });

      await untilScan("done");
      const res = await asUser(app, "u1").get("/digital/bandcamp/scan");
      expect(res.body.scan).toMatchObject({
        checked: 1,
        album: 1,
        tracks: 0,
        none: 0,
        failed: 0,
        skipped: 1,
        requestsDone: 1,
        requestsRemaining: 0,
        etaSeconds: null,
        current: null,
        pausedUntil: null,
      });
      expect(
        db.select().from(digitalMatches).where(eq(digitalMatches.releaseId, 1)).get(),
      ).toMatchObject({ status: "album" });
    });

    it("estimates the requests and time left while it runs", async () => {
      sessions.set("u1", "bandcamp", { headers: {} });
      let answer!: () => void;
      searchReleases.mockImplementationOnce(() => new Promise((resolve) => (answer = () => resolve([albumHit]))));

      await asUser(app, "u1").post("/digital/bandcamp/scan").send({});
      await vi.waitFor(() => expect(searchReleases).toHaveBeenCalled());
      const running = (await asUser(app, "u1").get("/digital/bandcamp/scan")).body.scan;

      expect(running).toMatchObject({
        status: "running",
        checked: 0,
        requestsDone: 1,
        requestsRemaining: 2,
        current: { releaseId: 1, title: "Permutation" },
      });
      // The test lane has no gap between requests, so the time left is nil.
      expect(running.etaSeconds).toBe(0);
      answer();
      await untilScan("done");
    });

    it("keeps one active scan and rejects a bad body", async () => {
      sessions.set("u1", "bandcamp", { headers: {} });
      let answer!: () => void;
      searchReleases.mockImplementationOnce(() => new Promise((resolve) => (answer = () => resolve([albumHit]))));
      await asUser(app, "u1").post("/digital/bandcamp/scan").send({});

      const again = await asUser(app, "u1").post("/digital/bandcamp/scan").send({});
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("scan_active");
      expect((await asUser(app, "u1").post("/digital/bandcamp/scan").send({ recheck: "yes" })).status).toBe(400);
      answer();
      await untilScan("done");
    });

    it("stops with needs-session when the store refuses the curl and carries on once a fresh one is pasted", async () => {
      sessions.set("u1", "bandcamp", { headers: {} });
      searchReleases.mockRejectedValueOnce(new StoreSessionExpiredError());
      await asUser(app, "u1").post("/digital/bandcamp/scan").send({});
      await untilScan("needs-session");

      await asUser(app, "u1").put("/digital/bandcamp/session").send({ curl: CURL });
      await untilScan("done");
      expect((await asUser(app, "u1").get("/digital/bandcamp/scan")).body.scan).toMatchObject({ album: 1 });
    });

    it("cancels the active scan", async () => {
      sessions.set("u1", "bandcamp", { headers: {} });
      expect((await asUser(app, "u1").post("/digital/bandcamp/scan/cancel")).body.code).toBe("no_active_scan");

      let answer!: () => void;
      searchReleases.mockImplementationOnce(() => new Promise((resolve) => (answer = () => resolve([albumHit]))));
      await asUser(app, "u1").post("/digital/bandcamp/scan").send({});
      await vi.waitFor(() => expect(searchReleases).toHaveBeenCalled());

      const res = await asUser(app, "u1").post("/digital/bandcamp/scan/cancel");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("cancelled");
      answer();
    });

    it("keeps each collector's scan to themselves, and rejects an unknown store", async () => {
      sessions.set("u1", "bandcamp", { headers: {} });
      await asUser(app, "u1").post("/digital/bandcamp/scan").send({});
      await untilScan("done");

      expect((await asUser(app, "u2").get("/digital/bandcamp/scan")).body).toEqual({ scan: null });
      expect((await asUser(app, "u1").get("/digital/beatport/scan")).status).toBe(404);
      expect((await asUser(app, "u1").post("/digital/beatport/scan")).status).toBe(404);
      expect((await asUser(app, "u1").post("/digital/beatport/scan/cancel")).status).toBe(404);
    });
  });

  describe("GET /wantlist", () => {
    it("carries each item's digital matches", async () => {
      sessions.set("u1", "bandcamp", { headers: {} });
      await asUser(app, "u1").post("/digital/bandcamp/matches").send({ releaseId: 1 });

      const res = await asUser(app, "u1").get("/wantlist");

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].digitalMatches).toEqual([
        expect.objectContaining({ store: "bandcamp", status: "album", url: albumHit.url, tracks: [] }),
      ]);
    });

    it("has no matches for an item that was not checked", async () => {
      const res = await asUser(app, "u2").get("/wantlist");
      expect(res.body.items[0].digitalMatches).toEqual([]);
    });
  });
});
