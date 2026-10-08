import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Express } from "express";
import { createDb, type Db } from "../db/client";
import { userSettings } from "../db/schema";
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
    patch: (url: string) => agent.patch(url).set(auth),
  };
}

describe("settings", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;
  let app: Express;

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
  });

  afterEach(() => {
    queue.stop();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  describe("GET /settings", () => {
    it("holds the defaults for a user who never changed anything, without storing them", async () => {
      const res = await asUser(app, "u1").get("/settings");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ theme: "dark" });
      expect(db.select().from(userSettings).all()).toEqual([]);
    });

    it("requires a signed-in user", async () => {
      const res = await request(app).get("/settings");

      expect(res.status).toBe(401);
    });

    it("returns only the signed-in user's own settings", async () => {
      await asUser(app, "u1").patch("/settings").send({ theme: "light" });

      const res = await asUser(app, "u2").get("/settings");

      expect(res.body).toEqual({ theme: "dark" });
    });
  });

  describe("PATCH /settings", () => {
    it("stores the theme and returns the full settings", async () => {
      const res = await asUser(app, "u1").patch("/settings").send({ theme: "light" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ theme: "light" });
      expect(db.select().from(userSettings).all()).toMatchObject([{ uid: "u1", theme: "light" }]);
      expect((await asUser(app, "u1").get("/settings")).body).toEqual({ theme: "light" });
    });

    it("changes the stored theme without adding a second row", async () => {
      await asUser(app, "u1").patch("/settings").send({ theme: "light" });
      await asUser(app, "u1").patch("/settings").send({ theme: "dark" });

      expect(db.select().from(userSettings).all()).toMatchObject([{ uid: "u1", theme: "dark" }]);
    });

    it("leaves the settings as they are when the patch names none", async () => {
      await asUser(app, "u1").patch("/settings").send({ theme: "light" });

      const res = await asUser(app, "u1").patch("/settings").send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ theme: "light" });
    });

    it.each([["sepia"], [""], [null], [1]])("rejects the theme %j", async (theme) => {
      const res = await asUser(app, "u1").patch("/settings").send({ theme });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "theme must be one of: light, dark" });
      expect(db.select().from(userSettings).all()).toEqual([]);
    });

    it("keeps one user's change away from another's", async () => {
      await asUser(app, "u1").patch("/settings").send({ theme: "light" });
      await asUser(app, "u2").patch("/settings").send({ theme: "dark" });

      expect((await asUser(app, "u1").get("/settings")).body).toEqual({ theme: "light" });
      expect(db.select().from(userSettings).all()).toHaveLength(2);
    });
  });
});
