import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Express } from "express";
import { createDb, type Db } from "../db/client";
import { discogsTokens, hiddenReleases, releases, wantlistItems } from "../db/schema";
import { encryptToken } from "../util/token-crypto";
import { and, eq } from "drizzle-orm";
import { DiscogsAuthError } from "../discogs-client";
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
    delete: (url: string) => request(app).delete(url).set(auth),
  };
}

describe("wantlist", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;
  let app: Express;

  function seedRelease(id: number, title: string, artist: string, numForSale: number | null, fetchedAt?: Date) {
    db.insert(releases)
      .values({
        id,
        title,
        videos: [],
        tracklist: [],
        year: 1990 + id,
        genres: [],
        styles: [],
        formats: [{ name: "Vinyl", descriptions: ["LP"] }],
        labels: [],
        artists: [{ id: id * 10, name: artist }],
        masterId: null,
        numForSale,
        numForSaleAt: fetchedAt ?? null,
      })
      .run();
  }

  function want(uid: string, releaseId: number, title: string, addedAt: Date | null = null) {
    db.insert(wantlistItems)
      .values({ uid, releaseId, masterId: null, title, artists: [{ id: 1, name: "Stored Artist" }], addedAt })
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

    seedRelease(1, "Common", "Zed", 40, new Date("2026-10-01T00:00:00Z"));
    seedRelease(2, "Scarce", "Mid", 1, new Date("2026-10-03T00:00:00Z"));
    seedRelease(3, "Unfetched", "Abe", null);
    seedRelease(4, "Gone", "Mid", 0, new Date("2026-10-02T00:00:00Z"));
    want("u1", 1, "Common", new Date("2026-01-01T00:00:00Z"));
    want("u1", 2, "Scarce", new Date("2026-03-01T00:00:00Z"));
    want("u1", 3, "Unfetched");
    want("u1", 4, "Gone", new Date("2026-02-01T00:00:00Z"));
    want("u1", 900, "Not Enriched", new Date("2026-04-01T00:00:00Z"));
    want("u1", 901, "Also Not Enriched");
    want("u2", 2, "Scarce");
    want("u2", 902, "Theirs Only");
  });

  afterEach(() => {
    queue.stop();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  const ids = (body: { items: { releaseId: number }[] }) => body.items.map((item) => item.releaseId);

  it("requires a signed-in user", async () => {
    expect((await request(app).get("/wantlist")).status).toBe(401);
    expect((await request(app).get("/wantlist/unmatched")).status).toBe(401);
  });

  it("lists the enriched items fewest for sale first, items with no count last", async () => {
    db.update(releases).set({ lowestPrice: 4.5, thumb: "https://i.discogs.com/t.jpg" }).where(eq(releases.id, 2)).run();
    const res = await asUser(app, "u1").get("/wantlist");

    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([4, 2, 1, 3]);
    expect(res.body).toMatchObject({
      page: 1,
      pageSize: 50,
      total: 4,
      unmatchedCount: 2,
      availabilityUpdatedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(res.body.items[1]).toEqual({
      releaseId: 2,
      title: "Scarce",
      year: 1992,
      formats: [{ name: "Vinyl", descriptions: ["LP"] }],
      artists: [{ id: 20, name: "Mid" }],
      numForSale: 1,
      lowestPrice: 4.5,
      thumb: "https://i.discogs.com/t.jpg",
      addedAt: "2026-03-01T00:00:00.000Z",
    });
  });

  it("hides items with none for sale, keeping those with no count yet, and counts the tab without the filter", async () => {
    const res = await asUser(app, "u1").get("/wantlist?hideNoneForSale=true");

    expect(ids(res.body)).toEqual([2, 1, 3]);
    expect(res.body).toMatchObject({ total: 3, wantlistCount: 4, unmatchedCount: 2 });
    expect((await asUser(app, "u1").get("/wantlist?hideNoneForSale=false")).body.total).toBe(4);
  });

  it("sorts by date added (newest first, undated last), artist and title", async () => {
    expect(ids((await asUser(app, "u1").get("/wantlist?sort=-addedAt")).body)).toEqual([2, 4, 1, 3]);
    expect(ids((await asUser(app, "u1").get("/wantlist?sort=artist")).body)).toEqual([3, 2, 4, 1]);
    expect(ids((await asUser(app, "u1").get("/wantlist?sort=title")).body)).toEqual([1, 4, 2, 3]);
  });

  it("pages the wantlist", async () => {
    const res = await asUser(app, "u1").get("/wantlist?pageSize=3&page=2");

    expect(ids(res.body)).toEqual([3]);
    expect(res.body).toMatchObject({ page: 2, pageSize: 3, total: 4 });
  });

  it("rejects invalid paging and sort", async () => {
    for (const query of ["page=0", "pageSize=abc", "pageSize=1000", "sort=rating"]) {
      expect((await asUser(app, "u1").get(`/wantlist?${query}`)).status).toBe(400);
    }
    expect((await asUser(app, "u1").get("/wantlist/unmatched?page=0")).status).toBe(400);
  });

  it("lists items without a release row only under unmatched, with the stored title and artists", async () => {
    const res = await asUser(app, "u1").get("/wantlist/unmatched");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 50, total: 2, wantlistCount: 4 });
    expect(res.body.items).toEqual([
      {
        releaseId: 900,
        title: "Not Enriched",
        artists: [{ id: 1, name: "Stored Artist" }],
        source: "Discogs wantlist",
        addedAt: "2026-04-01T00:00:00.000Z",
      },
      {
        releaseId: 901,
        title: "Also Not Enriched",
        artists: [{ id: 1, name: "Stored Artist" }],
        source: "Discogs wantlist",
        addedAt: null,
      },
    ]);
  });

  it("moves an item to the wantlist once its release row exists", async () => {
    seedRelease(900, "Not Enriched", "Someone", 5, new Date("2026-10-04T00:00:00Z"));

    const wantlist = await asUser(app, "u1").get("/wantlist");
    const unmatched = await asUser(app, "u1").get("/wantlist/unmatched");

    expect(ids(wantlist.body)).toEqual([4, 2, 900, 1, 3]);
    expect(ids(unmatched.body)).toEqual([901]);
  });


  describe("removing an item", () => {
    const remove = vi.fn<(releaseId: number) => Promise<void>>();

    beforeEach(() => {
      process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
      remove.mockReset().mockResolvedValue();
      db.insert(discogsTokens)
        .values({ uid: "u1", tokenEncrypted: encryptToken("tok"), username: "dan", createdAt: new Date() })
        .run();
      db.insert(hiddenReleases).values({ uid: "u1", releaseId: 2 }).run();
      queue.registerHandler("wantlist_remove", async ({ uid, releaseId }) => {
        await remove(releaseId);
        db.delete(wantlistItems).where(and(eq(wantlistItems.uid, uid), eq(wantlistItems.releaseId, releaseId))).run();
      });
      queue.start();
    });

    it("queues the removal at inline priority, ahead of sync and enrichment work, and answers 204", async () => {
      const res = await asUser(app, "u1").delete("/wantlist/2");

      expect(res.status).toBe(204);
      expect(remove).toHaveBeenCalledWith(2);
      expect(ids((await asUser(app, "u1").get("/wantlist")).body)).toEqual([4, 1, 3]);
    });

    it("runs ahead of background jobs already waiting", async () => {
      for (let releaseId = 100; releaseId < 105; releaseId += 1) {
        queue.enqueue({ runId: "bg", type: "release_detail", payload: { uid: "u1", releaseId } });
      }
      const row = db.$client.prepare("select priority from discogs_queue_jobs order by id desc limit 1");
      expect((row.get() as { priority: number }).priority).toBe(0);

      expect((await asUser(app, "u1").delete("/wantlist/2")).status).toBe(204);
      const job = db.$client
        .prepare("select priority from discogs_queue_jobs where type = 'wantlist_remove'")
        .get() as { priority: number };
      expect(job.priority).toBe(10);
    });

    it("404s a release that is not on the wantlist, and never touches another collector's", async () => {
      expect((await asUser(app, "u1").delete("/wantlist/902")).status).toBe(404);
      expect((await asUser(app, "u1").delete("/wantlist/abc")).status).toBe(400);
      expect(remove).not.toHaveBeenCalled();
    });

    it("asks for a token when there is none", async () => {
      expect((await asUser(app, "u2").delete("/wantlist/902")).status).toBe(409);
    });

    it("reports a refused token as 400, not 401, and keeps the item", async () => {
      remove.mockRejectedValue(new DiscogsAuthError("no"));
      queue.registerHandler("wantlist_remove", async () => {
        throw new DiscogsAuthError("no");
      });

      expect((await asUser(app, "u1").delete("/wantlist/2")).status).toBe(400);
      expect(ids((await asUser(app, "u1").get("/wantlist")).body)).toContain(2);
    });
  });

  it("never shows another collector's wantlist", async () => {
    const wantlist = await asUser(app, "u2").get("/wantlist");
    const unmatched = await asUser(app, "u2").get("/wantlist/unmatched");
    const stranger = await asUser(app, "u3").get("/wantlist");

    expect(ids(wantlist.body)).toEqual([2]);
    expect(ids(unmatched.body)).toEqual([902]);
    expect(stranger.body).toMatchObject({ items: [], total: 0, unmatchedCount: 0, availabilityUpdatedAt: null });
  });
});
