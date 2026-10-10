import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Express } from "express";
import { createDb, type Db } from "../db/client";
import { fades, releases, sellerInventory } from "../db/schema";
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
    delete: (url: string) => agent.delete(url).set(auth),
  };
}

describe("fade", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;
  let app: Express;

  function seedRelease(
    id: number,
    masterId: number | null,
    overrides: Partial<{
      genres: string[];
      styles: string[];
      title: string;
      artists: string[];
    }> = {},
  ) {
    db.insert(releases)
      .values({
        id,
        title: overrides.title ?? `Release ${id}`,
        masterId,
        year: 2000,
        genres: overrides.genres ?? [],
        styles: overrides.styles ?? [],
        formats: [],
        labelIds: [],
        artists: (overrides.artists ?? []).map((name, i) => ({ id: i + 1, name })),
      })
      .run();
  }

  function seedInventory(seller: string, releaseId: number, status: "active" | "sold" = "active") {
    const now = new Date();
    db.insert(sellerInventory)
      .values({
        sellerUsername: seller,
        releaseId,
        status,
        firstSeenAt: now,
        lastSeenAt: now,
        soldAt: null,
      })
      .run();
  }

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

  describe("POST /fade", () => {
    it("stores the master when the release has one", async () => {
      seedRelease(111, 900);

      const res = await asUser(app, "u1").post("/fade").send({ releaseId: 111 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ kind: "master", id: 900 });
      expect(db.select().from(fades).all()).toMatchObject([{ uid: "u1", kind: "master", id: 900 }]);
    });

    it("stores the release itself when it has no master", async () => {
      seedRelease(555, null);

      const res = await asUser(app, "u1").post("/fade").send({ releaseId: 555 });

      expect(res.body).toEqual({ kind: "release", id: 555 });
    });

    it("stores a master directly", async () => {
      const res = await asUser(app, "u1").post("/fade").send({ masterId: 900 });

      expect(res.body).toEqual({ kind: "master", id: 900 });
    });

    it("is idempotent", async () => {
      seedRelease(111, 900);
      seedRelease(112, 900);

      await asUser(app, "u1").post("/fade").send({ releaseId: 111 });
      const again = await asUser(app, "u1").post("/fade").send({ releaseId: 112 });

      expect(again.status).toBe(200);
      expect(db.select().from(fades).all()).toHaveLength(1);
    });

    it("returns 404 for a release that isn't indexed", async () => {
      const res = await asUser(app, "u1").post("/fade").send({ releaseId: 999 });

      expect(res.status).toBe(404);
    });

    it("returns 400 unless exactly one valid id is given", async () => {
      const user = asUser(app, "u1");

      expect((await user.post("/fade").send({})).status).toBe(400);
      expect((await user.post("/fade").send({ releaseId: 1, masterId: 2 })).status).toBe(400);
      expect((await user.post("/fade").send({ releaseId: "abc" })).status).toBe(400);
      expect((await user.post("/fade").send({ masterId: 1.5 })).status).toBe(400);
    });
  });

  describe("GET /fade", () => {
    it("returns only the signed-in user's faded masters and releases", async () => {
      seedRelease(111, 900);
      seedRelease(555, null);
      await asUser(app, "u1").post("/fade").send({ releaseId: 111 });
      await asUser(app, "u1").post("/fade").send({ releaseId: 555 });
      await asUser(app, "u2").post("/fade").send({ masterId: 777 });

      const res = await asUser(app, "u1").get("/fade");

      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toEqual({ masterIds: [900], releaseIds: [555] });
    });
  });

  describe("DELETE /fade", () => {
    it("unfades a master, and every version with it", async () => {
      seedRelease(111, 900);
      seedRelease(112, 900);
      await asUser(app, "u1").post("/fade").send({ releaseId: 111 });

      const res = await asUser(app, "u1").delete("/fade").send({ masterId: 900 });

      expect(res.status).toBe(204);
      expect(db.select().from(fades).all()).toEqual([]);
    });

    it("resolves a release to its master like fade does", async () => {
      seedRelease(111, 900);
      await asUser(app, "u1").post("/fade").send({ releaseId: 111 });

      const res = await asUser(app, "u1").delete("/fade").send({ releaseId: 111 });

      expect(res.status).toBe(204);
      expect(db.select().from(fades).all()).toEqual([]);
    });

    it("unfades a release without a master, even one that is no longer indexed", async () => {
      seedRelease(555, null);
      await asUser(app, "u1").post("/fade").send({ releaseId: 555 });
      db.delete(releases).run();

      await asUser(app, "u1").delete("/fade").send({ releaseId: 555 });

      expect(db.select().from(fades).all()).toEqual([]);
    });

    it("leaves other collectors' fades alone and is idempotent", async () => {
      await asUser(app, "u2").post("/fade").send({ masterId: 900 });

      const first = await asUser(app, "u1").delete("/fade").send({ masterId: 900 });
      const second = await asUser(app, "u1").delete("/fade").send({ masterId: 900 });

      expect(first.status).toBe(204);
      expect(second.status).toBe(204);
      expect(db.select().from(fades).all()).toMatchObject([{ uid: "u2", id: 900 }]);
    });

    it("returns 400 unless exactly one valid id is given", async () => {
      const user = asUser(app, "u1");

      expect((await user.delete("/fade").send({})).status).toBe(400);
      expect((await user.delete("/fade").send({ releaseId: 1, masterId: 2 })).status).toBe(400);
    });
  });

  describe("GET /fade/items", () => {
    function fadeAt(uid: string, kind: "master" | "release", id: number, at: number) {
      db.insert(fades).values({ uid, kind, id, createdAt: new Date(at) }).run();
    }

    beforeEach(() => {
      seedRelease(111, 900, { title: "Alpha", artists: ["Aphex Twin"] });
      seedRelease(112, 900, { title: "Alpha (Remaster)", artists: ["Aphex Twin"] });
      seedRelease(555, null, { title: "Beta", artists: ["Boards of Canada"] });
      fadeAt("u1", "master", 900, 1000);
      fadeAt("u1", "release", 555, 2000);
      fadeAt("u1", "master", 777, 3000);
      fadeAt("u2", "master", 900, 4000);
    });

    it("lists the signed-in user's fades newest first with a representative release", async () => {
      const res = await asUser(app, "u1").get("/fade/items");

      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toMatchObject({ page: 1, pageSize: 50, total: 3, fadedTotal: 3 });
      expect(res.body.items).toEqual([
        {
          kind: "master",
          id: 777,
          fadedAt: new Date(3000).toISOString(),
          title: null,
          artists: [],
          year: null,
          thumb: null,
          versionsIndexed: 0,
        },
        expect.objectContaining({ kind: "release", id: 555, title: "Beta", versionsIndexed: 1 }),
        expect.objectContaining({
          kind: "master",
          id: 900,
          title: "Alpha",
          artists: [{ id: 1, name: "Aphex Twin" }],
          versionsIndexed: 2,
        }),
      ]);
    });

    it("searches title and artist across every version, keeping fadedTotal unfiltered", async () => {
      const byTitle = await asUser(app, "u1").get("/fade/items?q=remaster");
      const byArtist = await asUser(app, "u1").get("/fade/items?q=BOARDS");

      expect(byTitle.body.items.map((i: { id: number }) => i.id)).toEqual([900]);
      expect(byTitle.body).toMatchObject({ total: 1, fadedTotal: 3 });
      expect(byArtist.body.items.map((i: { id: number }) => i.id)).toEqual([555]);
    });

    it("paginates", async () => {
      const res = await asUser(app, "u1").get("/fade/items?page=2&pageSize=2");

      expect(res.body).toMatchObject({ page: 2, pageSize: 2, total: 3 });
      expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([900]);
    });

    it("returns 400 for a bad page or pageSize", async () => {
      expect((await asUser(app, "u1").get("/fade/items?page=0")).status).toBe(400);
      expect((await asUser(app, "u1").get("/fade/items?pageSize=x")).status).toBe(400);
    });
  });

  describe("hiding faded releases", () => {
    beforeEach(() => {
      // 111 and 112 are versions of master 900, 555 has no master, 300 is a different master
      seedRelease(111, 900, { styles: ["Techno"] });
      seedRelease(112, 900, { styles: ["Techno"] });
      seedRelease(555, null, { styles: ["Ambient"] });
      seedRelease(300, 301, { styles: ["House"] });
      for (const id of [111, 112, 555, 300]) seedInventory("seller-1", id);
      seedInventory("seller-2", 112);
      seedInventory("seller-2", 300);
    });

    it("hides every version of a faded master, across sellers", async () => {
      const user = asUser(app, "u1");
      await user.post("/fade").send({ releaseId: 111 });

      const one = await user.get("/sellers/seller-1/inventory");
      expect(one.body.items.map((i: { releaseId: number }) => i.releaseId).sort()).toEqual([300, 555]);

      const two = await user.get("/sellers/seller-2/inventory");
      expect(two.body.items.map((i: { releaseId: number }) => i.releaseId)).toEqual([300]);
    });

    it("hides a faded release that has no master", async () => {
      const user = asUser(app, "u1");
      await user.post("/fade").send({ releaseId: 555 });

      const res = await user.get("/sellers/seller-1/inventory");
      expect(res.body.items.map((i: { releaseId: number }) => i.releaseId).sort()).toEqual([111, 112, 300]);
    });

    it("hides a version that is added to a faded master later", async () => {
      const user = asUser(app, "u1");
      await user.post("/fade").send({ masterId: 900 });
      seedRelease(113, 900);
      seedInventory("seller-1", 113);

      const res = await user.get("/sellers/seller-1/inventory");
      expect(res.body.items.map((i: { releaseId: number }) => i.releaseId).sort()).toEqual([300, 555]);
    });

    it("does not hide anything for other users", async () => {
      await asUser(app, "u1").post("/fade").send({ releaseId: 111 });

      const res = await asUser(app, "u2").get("/sellers/seller-1/inventory");
      expect(res.body.items).toHaveLength(4);
      expect(res.body).toMatchObject({ total: 4, forSaleCount: 4, fadedCount: 0 });
    });

    it("reports for-sale and faded counts that ignore filters, with total following the filters", async () => {
      const user = asUser(app, "u1");
      await user.post("/fade").send({ releaseId: 111 });

      const res = await user.get("/sellers/seller-1/inventory?style=Ambient");

      expect(res.body).toMatchObject({ total: 1, forSaleCount: 4, fadedCount: 2 });
    });

    it("counts only active enriched items in forSaleCount", async () => {
      seedInventory("seller-1", 999); // not enriched
      seedRelease(600, null);
      seedInventory("seller-1", 600, "sold");

      const res = await asUser(app, "u1").get("/sellers/seller-1/inventory");

      expect(res.body).toMatchObject({ forSaleCount: 4, fadedCount: 0 });
    });

    it("leaves facet options only for what is still visible", async () => {
      const user = asUser(app, "u1");
      await user.post("/fade").send({ masterId: 900 });

      const res = await user.get("/sellers/seller-1/inventory/facets");
      expect(res.body.styles.map((s: { value: string }) => s.value)).toEqual(["Ambient", "House"]);
    });

    it("keeps a facet option while an unfaded release still carries it", async () => {
      seedRelease(700, null, { styles: ["Techno"] });
      seedInventory("seller-1", 700);
      const user = asUser(app, "u1");
      await user.post("/fade").send({ masterId: 900 });

      const res = await user.get("/sellers/seller-1/inventory/facets");
      expect(res.body.styles).toContainEqual({ value: "Techno", count: 1 });
    });
  });
});
