import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import request from "supertest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Express } from "express";
import { createDb, type Db } from "../db/client";
import { discogsProfiles } from "../db/schema";
import { DiscogsAuthError, DiscogsTransientError, type DiscogsProfile } from "../discogs-client";
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

describe("discogs profile", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;
  let app: Express;
  let getDiscogsProfile: Mock<(token: string) => Promise<DiscogsProfile>>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    queue = new DiscogsQueue(db);
    getDiscogsProfile = vi.fn(async () => ({ username: "dan", collectionCount: 120, wantlistCount: 7 }));
    app = createApp({
      db,
      queue,
      getIdentity: async () => ({ id: 1, username: "dan" }),
      getDiscogsProfile,
    });

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

  it("requires a signed-in user", async () => {
    expect((await request(app).get("/me/discogs-profile")).status).toBe(401);
    expect((await request(app).post("/me/discogs-profile/refresh")).status).toBe(401);
  });

  describe("GET", () => {
    it("reports no token and no profile to a collector with neither", async () => {
      const res = await asUser(app, "u1").get("/me/discogs-profile");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ tokenSet: false, profile: null });
    });

    it("reports a token with no profile until the first refresh, and fetches nothing", async () => {
      await saveToken("u1");

      const res = await asUser(app, "u1").get("/me/discogs-profile");

      expect(res.body).toEqual({ tokenSet: true, profile: null });
      expect(getDiscogsProfile).not.toHaveBeenCalled();
    });
  });

  describe("POST /refresh", () => {
    it("fetches with the saved token, caches the profile and returns it", async () => {
      await saveToken("u1", "abc123");

      const res = await asUser(app, "u1").post("/me/discogs-profile/refresh");

      expect(res.status).toBe(200);
      expect(getDiscogsProfile).toHaveBeenCalledWith("abc123");
      expect(res.body).toMatchObject({
        tokenSet: true,
        profile: { username: "dan", collectionCount: 120, wantlistCount: 7 },
      });
      expect(Number.isNaN(Date.parse(res.body.profile.fetchedAt))).toBe(false);

      const read = await asUser(app, "u1").get("/me/discogs-profile");
      expect(read.body).toEqual(res.body);
      expect(JSON.stringify(res.body)).not.toContain("abc123");
    });

    it("replaces the cached profile on a second refresh", async () => {
      await saveToken("u1");
      await asUser(app, "u1").post("/me/discogs-profile/refresh");
      getDiscogsProfile.mockResolvedValue({ username: "dan", collectionCount: 121, wantlistCount: 6 });

      const res = await asUser(app, "u1").post("/me/discogs-profile/refresh");

      expect(res.body.profile).toMatchObject({ collectionCount: 121, wantlistCount: 6 });
      expect(db.select().from(discogsProfiles).all()).toHaveLength(1);
    });

    it("answers 409 without a token, without asking Discogs", async () => {
      const res = await asUser(app, "u1").post("/me/discogs-profile/refresh");

      expect(res.status).toBe(409);
      expect(getDiscogsProfile).not.toHaveBeenCalled();
    });

    it("answers 400, not 401, when Discogs rejects the token, and keeps the cached profile", async () => {
      await saveToken("u1");
      await asUser(app, "u1").post("/me/discogs-profile/refresh");
      getDiscogsProfile.mockRejectedValue(new DiscogsAuthError("revoked"));

      const res = await asUser(app, "u1").post("/me/discogs-profile/refresh");

      expect(res.status).toBe(400);
      const read = await asUser(app, "u1").get("/me/discogs-profile");
      expect(read.body.profile).toMatchObject({ collectionCount: 120 });
    });

    it("answers 502 when Discogs fails, and caches nothing", async () => {
      await saveToken("u1");
      getDiscogsProfile.mockRejectedValue(new DiscogsTransientError("down"));

      const res = await asUser(app, "u1").post("/me/discogs-profile/refresh");

      expect(res.status).toBe(502);
      expect(db.select().from(discogsProfiles).all()).toEqual([]);
    });

    it("keeps each collector's profile separate", async () => {
      await saveToken("u1");
      await asUser(app, "u1").post("/me/discogs-profile/refresh");

      const res = await asUser(app, "u2").get("/me/discogs-profile");

      expect(res.body).toEqual({ tokenSet: false, profile: null });
    });
  });

  describe("when the token changes", () => {
    it("drops the cached profile when the token is removed", async () => {
      await saveToken("u1");
      await asUser(app, "u1").post("/me/discogs-profile/refresh");

      await asUser(app, "u1").delete("/settings/discogs-token");

      const res = await asUser(app, "u1").get("/me/discogs-profile");
      expect(res.body).toEqual({ tokenSet: false, profile: null });
    });

    it("drops the cached profile when the token is replaced", async () => {
      await saveToken("u1", "first");
      await asUser(app, "u1").post("/me/discogs-profile/refresh");

      await saveToken("u1", "second");

      const res = await asUser(app, "u1").get("/me/discogs-profile");
      expect(res.body).toEqual({ tokenSet: true, profile: null });
    });

    it("leaves another collector's profile alone", async () => {
      await saveToken("u1");
      await saveToken("u2");
      await asUser(app, "u2").post("/me/discogs-profile/refresh");

      await asUser(app, "u1").delete("/settings/discogs-token");

      const res = await asUser(app, "u2").get("/me/discogs-profile");
      expect(res.body.profile).not.toBeNull();
    });
  });
});
