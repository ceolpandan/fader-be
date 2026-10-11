import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Express } from "express";
import { createDb, type Db } from "../db/client";
import { savedFilters } from "../db/schema";
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
    post: (url: string) => agent.post(url).set(auth),
    patch: (url: string) => agent.patch(url).set(auth),
    delete: (url: string) => agent.delete(url).set(auth),
  };
}

const QUERY = "onlyGenre=Electronic&tracks=2&format=Vinyl&sort=-year";

describe("saved filters", () => {
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

  it("requires a signed-in user", async () => {
    expect((await request(app).get("/saved-filters")).status).toBe(401);
  });

  it("starts empty", async () => {
    const res = await asUser(app, "u1").get("/saved-filters");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  describe("POST /saved-filters", () => {
    it("saves a filter and lists it", async () => {
      const res = await asUser(app, "u1").post("/saved-filters").send({ name: "Dub", query: QUERY });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: "Dub", query: QUERY });
      expect(typeof res.body.id).toBe("number");

      const list = await asUser(app, "u1").get("/saved-filters");
      expect(list.body).toEqual([res.body]);
    });

    it("trims the name and drops a leading question mark from the query", async () => {
      const res = await asUser(app, "u1").post("/saved-filters").send({ name: "  Dub  ", query: `?${QUERY}` });

      expect(res.body).toMatchObject({ name: "Dub", query: QUERY });
    });

    it("answers 409 for a query the user already saved, and creates nothing", async () => {
      await asUser(app, "u1").post("/saved-filters").send({ name: "Dub", query: QUERY });

      const res = await asUser(app, "u1").post("/saved-filters").send({ name: "Other name", query: QUERY });

      expect(res.status).toBe(409);
      expect(db.select().from(savedFilters).all()).toHaveLength(1);
    });

    it("lets two users save the same query", async () => {
      await asUser(app, "u1").post("/saved-filters").send({ name: "Dub", query: QUERY });

      const res = await asUser(app, "u2").post("/saved-filters").send({ name: "Dub", query: QUERY });

      expect(res.status).toBe(201);
    });

    it.each([
      [{ name: "", query: QUERY }],
      [{ name: "   ", query: QUERY }],
      [{ name: 5, query: QUERY }],
      [{ name: "x".repeat(201), query: QUERY }],
      [{ name: "Dub", query: "" }],
      [{ name: "Dub", query: "?" }],
      [{ name: "Dub" }],
      [{ name: "Dub", query: "q".repeat(4001) }],
    ])("rejects %j with 400", async (body) => {
      const res = await asUser(app, "u1").post("/saved-filters").send(body);

      expect(res.status).toBe(400);
      expect(db.select().from(savedFilters).all()).toEqual([]);
    });
  });

  describe("GET /saved-filters", () => {
    it("lists only the signed-in user's filters, oldest first", async () => {
      await asUser(app, "u1").post("/saved-filters").send({ name: "First", query: "a=1" });
      await asUser(app, "u2").post("/saved-filters").send({ name: "Theirs", query: "b=1" });
      await asUser(app, "u1").post("/saved-filters").send({ name: "Second", query: "c=1" });

      const res = await asUser(app, "u1").get("/saved-filters");

      expect(res.body.map((f: { name: string }) => f.name)).toEqual(["First", "Second"]);
    });
  });

  describe("PATCH /saved-filters/:id", () => {
    it("renames and keeps the query", async () => {
      const { body: saved } = await asUser(app, "u1").post("/saved-filters").send({ name: "Dub", query: QUERY });

      const res = await asUser(app, "u1").patch(`/saved-filters/${saved.id}`).send({ name: " Dub techno " });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ...saved, name: "Dub techno" });
    });

    it("rejects an empty name with 400", async () => {
      const { body: saved } = await asUser(app, "u1").post("/saved-filters").send({ name: "Dub", query: QUERY });

      const res = await asUser(app, "u1").patch(`/saved-filters/${saved.id}`).send({ name: " " });

      expect(res.status).toBe(400);
    });

    it("answers 404 for another user's filter or an unknown id", async () => {
      const { body: saved } = await asUser(app, "u1").post("/saved-filters").send({ name: "Dub", query: QUERY });

      expect((await asUser(app, "u2").patch(`/saved-filters/${saved.id}`).send({ name: "Mine" })).status).toBe(404);
      expect((await asUser(app, "u1").patch("/saved-filters/9999").send({ name: "x" })).status).toBe(404);
      expect((await asUser(app, "u1").patch("/saved-filters/abc").send({ name: "x" })).status).toBe(404);
      expect(db.select().from(savedFilters).get()?.name).toBe("Dub");
    });
  });

  describe("DELETE /saved-filters/:id", () => {
    it("deletes the filter, so the same query can be saved again", async () => {
      const { body: saved } = await asUser(app, "u1").post("/saved-filters").send({ name: "Dub", query: QUERY });

      const res = await asUser(app, "u1").delete(`/saved-filters/${saved.id}`);

      expect(res.status).toBe(204);
      expect((await asUser(app, "u1").get("/saved-filters")).body).toEqual([]);
      expect((await asUser(app, "u1").post("/saved-filters").send({ name: "Dub", query: QUERY })).status).toBe(201);
    });

    it("answers 404 for another user's filter and leaves it", async () => {
      const { body: saved } = await asUser(app, "u1").post("/saved-filters").send({ name: "Dub", query: QUERY });

      const res = await asUser(app, "u2").delete(`/saved-filters/${saved.id}`);

      expect(res.status).toBe(404);
      expect(db.select().from(savedFilters).all()).toHaveLength(1);
    });
  });
});
