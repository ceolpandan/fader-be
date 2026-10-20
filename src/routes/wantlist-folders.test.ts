import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Express } from "express";
import { createDb, type Db } from "../db/client";
import { releases, wantlistFolderItems, wantlistFolders, wantlistItems } from "../db/schema";
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
  const auth = { Authorization: "Bearer test-token" };
  return {
    get: (url: string) => request(app).get(url).set(auth),
    post: (url: string, body: object) => request(app).post(url).set(auth).send(body),
    put: (url: string, body: object) => request(app).put(url).set(auth).send(body),
    patch: (url: string, body: object) => request(app).patch(url).set(auth).send(body),
    delete: (url: string, body?: object) => request(app).delete(url).set(auth).send(body),
  };
}

describe("wantlist folders", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;
  let app: Express;

  function seedRelease(id: number, numForSale: number | null) {
    db.insert(releases)
      .values({
        id,
        title: `Release ${id}`,
        videos: [],
        tracklist: [],
        year: 1990 + id,
        genres: [],
        styles: [],
        formats: [],
        labels: [],
        artists: [{ id: id * 10, name: "Artist" }],
        masterId: null,
        numForSale,
      })
      .run();
  }

  function want(uid: string, releaseId: number) {
    db.insert(wantlistItems)
      .values({ uid, releaseId, masterId: null, title: `Release ${releaseId}`, artists: [], addedAt: null })
      .run();
  }

  const membership = (uid = "u1") =>
    db
      .select()
      .from(wantlistFolderItems)
      .all()
      .filter((row) => row.uid === uid)
      .map((row) => [row.releaseId, row.folderId]);

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

    for (const id of [1, 2, 3, 4]) seedRelease(id, id);
    for (const id of [1, 2, 3, 4, 900]) want("u1", id);
    want("u2", 1);
    want("u2", 2);
  });

  afterEach(() => {
    queue.stop();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  it("requires a signed-in user", async () => {
    expect((await request(app).get("/wantlist/folders")).status).toBe(401);
  });

  describe("create", () => {
    it("creates a folder and moves the releases in, reporting those not on the wantlist", async () => {
      const res = await asUser(app, "u1").post("/wantlist/folders", { name: "  Maybe ", releaseIds: [1, 2, 777, 1] });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: expect.any(Number), name: "Maybe", itemCount: 2, ignoredReleaseIds: [777] });
      expect(membership()).toEqual([
        [1, res.body.id],
        [2, res.body.id],
      ]);
    });

    it("creates an empty folder when no release ids are given", async () => {
      const res = await asUser(app, "u1").post("/wantlist/folders", { name: "Empty" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: "Empty", itemCount: 0, ignoredReleaseIds: [] });
    });

    it("moves a release out of the folder it was in", async () => {
      const first = await asUser(app, "u1").post("/wantlist/folders", { name: "A", releaseIds: [1] });
      const second = await asUser(app, "u1").post("/wantlist/folders", { name: "B", releaseIds: [1] });

      expect(membership()).toEqual([[1, second.body.id]]);
      const list = await asUser(app, "u1").get("/wantlist/folders");
      expect(list.body).toEqual([
        { id: first.body.id, name: "A", itemCount: 0 },
        { id: second.body.id, name: "B", itemCount: 1 },
      ]);
    });

    it("rejects a duplicate name ignoring case, but only within the collector", async () => {
      await asUser(app, "u1").post("/wantlist/folders", { name: "Maybe" });

      expect((await asUser(app, "u1").post("/wantlist/folders", { name: " MAYBE " })).status).toBe(409);
      expect((await asUser(app, "u2").post("/wantlist/folders", { name: "maybe" })).status).toBe(201);
    });

    it("keeps nothing when the name is a duplicate", async () => {
      await asUser(app, "u1").post("/wantlist/folders", { name: "Maybe" });
      await asUser(app, "u1").post("/wantlist/folders", { name: "maybe", releaseIds: [1] });

      expect(membership()).toEqual([]);
    });

    it.each([
      ["a blank name", { name: "   " }],
      ["a missing name", {}],
      ["a name over 50 characters", { name: "x".repeat(51) }],
      ["release ids that are not an array", { name: "A", releaseIds: "1" }],
      ["a release id that is not a positive integer", { name: "A", releaseIds: [1, 0] }],
    ])("rejects %s", async (_label, body) => {
      expect((await asUser(app, "u1").post("/wantlist/folders", body)).status).toBe(400);
    });

    it("accepts a name of exactly 50 characters", async () => {
      expect((await asUser(app, "u1").post("/wantlist/folders", { name: "x".repeat(50) })).status).toBe(201);
    });
  });

  describe("list", () => {
    it("sorts case-insensitively and counts only the live wantlist, for the collector alone", async () => {
      const b = await asUser(app, "u1").post("/wantlist/folders", { name: "beta", releaseIds: [1, 2] });
      const a = await asUser(app, "u1").post("/wantlist/folders", { name: "Alpha", releaseIds: [3] });
      const c = await asUser(app, "u1").post("/wantlist/folders", { name: "Charlie" });
      await asUser(app, "u2").post("/wantlist/folders", { name: "Theirs" });
      // A membership row for a release that has left the wantlist is not counted.
      db.insert(wantlistFolderItems).values({ uid: "u1", releaseId: 555, folderId: c.body.id }).run();

      const res = await asUser(app, "u1").get("/wantlist/folders");

      expect(res.body).toEqual([
        { id: a.body.id, name: "Alpha", itemCount: 1 },
        { id: b.body.id, name: "beta", itemCount: 2 },
        { id: c.body.id, name: "Charlie", itemCount: 0 },
      ]);
    });
  });

  describe("items", () => {
    let folderId: number;
    let otherId: number;

    beforeEach(async () => {
      folderId = (await asUser(app, "u1").post("/wantlist/folders", { name: "Maybe", releaseIds: [1] })).body.id;
      otherId = (await asUser(app, "u1").post("/wantlist/folders", { name: "Later", releaseIds: [2] })).body.id;
    });

    it("moves releases in, silently out of another folder, and reports unknown ids", async () => {
      const res = await asUser(app, "u1").put(`/wantlist/folders/${folderId}/items`, { releaseIds: [2, 3, 777] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: folderId, name: "Maybe", itemCount: 3, ignoredReleaseIds: [777] });
      expect(membership()).toEqual([
        [1, folderId],
        [2, folderId],
        [3, folderId],
      ]);
      const list = await asUser(app, "u1").get("/wantlist/folders");
      expect(list.body.find((f: { id: number }) => f.id === otherId).itemCount).toBe(0);
    });

    it("removes releases from the folder, leaving other folders alone", async () => {
      const res = await asUser(app, "u1").delete(`/wantlist/folders/${folderId}/items`, { releaseIds: [1, 2, 777] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: folderId, name: "Maybe", itemCount: 0, ignoredReleaseIds: [777] });
      expect(membership()).toEqual([[2, otherId]]);
    });

    it("404s on another collector's folder and changes nothing", async () => {
      expect((await asUser(app, "u2").put(`/wantlist/folders/${folderId}/items`, { releaseIds: [1] })).status).toBe(404);
      expect((await asUser(app, "u2").delete(`/wantlist/folders/${folderId}/items`, { releaseIds: [1] })).status).toBe(404);
      expect(membership()).toEqual([
        [1, folderId],
        [2, otherId],
      ]);
    });

    it("400s on bad ids", async () => {
      expect((await asUser(app, "u1").put("/wantlist/folders/abc/items", { releaseIds: [1] })).status).toBe(400);
      expect((await asUser(app, "u1").put(`/wantlist/folders/${folderId}/items`, {})).status).toBe(400);
      expect((await asUser(app, "u1").delete(`/wantlist/folders/${folderId}/items`, { releaseIds: ["1"] })).status).toBe(400);
    });
  });

  describe("rename and delete", () => {
    let folderId: number;

    beforeEach(async () => {
      folderId = (await asUser(app, "u1").post("/wantlist/folders", { name: "Maybe", releaseIds: [1, 2] })).body.id;
      await asUser(app, "u1").post("/wantlist/folders", { name: "Later" });
    });

    it("renames a folder", async () => {
      const res = await asUser(app, "u1").patch(`/wantlist/folders/${folderId}`, { name: " Soon " });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: folderId, name: "Soon", itemCount: 2 });
    });

    it("allows a rename that only changes the case", async () => {
      expect((await asUser(app, "u1").patch(`/wantlist/folders/${folderId}`, { name: "MAYBE" })).status).toBe(200);
    });

    it("409s on a name another folder has, 400s on an invalid one, 404s on an unknown or foreign folder", async () => {
      expect((await asUser(app, "u1").patch(`/wantlist/folders/${folderId}`, { name: "later" })).status).toBe(409);
      expect((await asUser(app, "u1").patch(`/wantlist/folders/${folderId}`, { name: "" })).status).toBe(400);
      expect((await asUser(app, "u1").patch("/wantlist/folders/9999", { name: "X" })).status).toBe(404);
      expect((await asUser(app, "u2").patch(`/wantlist/folders/${folderId}`, { name: "X" })).status).toBe(404);
    });

    it("deletes the folder and un-folders its items", async () => {
      const res = await asUser(app, "u1").delete(`/wantlist/folders/${folderId}`);

      expect(res.status).toBe(204);
      expect(membership()).toEqual([]);
      expect(db.select().from(wantlistFolders).all().map((f) => f.name)).toEqual(["Later"]);
    });

    it("404s deleting an unknown or foreign folder", async () => {
      expect((await asUser(app, "u1").delete("/wantlist/folders/9999")).status).toBe(404);
      expect((await asUser(app, "u2").delete(`/wantlist/folders/${folderId}`)).status).toBe(404);
      expect(membership()).toHaveLength(2);
    });
  });

  describe("GET /wantlist filters", () => {
    let folderId: number;

    beforeEach(async () => {
      folderId = (await asUser(app, "u1").post("/wantlist/folders", { name: "Maybe", releaseIds: [1, 3, 900] })).body.id;
      db.update(releases).set({ numForSale: 0 }).where(eq(releases.id, 3)).run();
    });

    const ids = (body: { items: { releaseId: number }[] }) => body.items.map((item) => item.releaseId);

    it("folderId lists the matched items in that folder only", async () => {
      const res = await asUser(app, "u1").get(`/wantlist?folderId=${folderId}`);

      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual([3, 1]);
      expect(res.body).toMatchObject({ total: 2, wantlistCount: 4, unmatchedCount: 1 });
    });

    it("hideFoldered leaves out foldered items", async () => {
      const res = await asUser(app, "u1").get("/wantlist?hideFoldered=true");

      expect(ids(res.body)).toEqual([2, 4]);
      expect(res.body).toMatchObject({ total: 2, wantlistCount: 4 });
    });

    it("combines with hideNoneForSale, sort and pagination", async () => {
      const hidden = await asUser(app, "u1").get(`/wantlist?folderId=${folderId}&hideNoneForSale=true`);
      expect(ids(hidden.body)).toEqual([1]);
      expect(hidden.body.total).toBe(1);

      const sorted = await asUser(app, "u1").get("/wantlist?hideFoldered=true&sort=-addedAt&pageSize=1&page=2");
      expect(ids(sorted.body)).toEqual([4]);
      expect(sorted.body.total).toBe(2);
    });

    it("shows nothing for another collector's folder", async () => {
      const res = await asUser(app, "u2").get(`/wantlist?folderId=${folderId}`);

      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual([]);
    });

    it("400s on both together or a bad folderId", async () => {
      expect((await asUser(app, "u1").get(`/wantlist?folderId=${folderId}&hideFoldered=true`)).status).toBe(400);
      expect((await asUser(app, "u1").get("/wantlist?folderId=abc")).status).toBe(400);
    });
  });
});
