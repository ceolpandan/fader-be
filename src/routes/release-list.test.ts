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

describe("GET /releases and /releases/facets", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;
  let app: Express;

  const get = (url: string) => request(app).get(url).set("Authorization", "Bearer test-token");

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
      masterId: number | null;
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
        masterId: overrides.masterId ?? null,
      })
      .run();
  }

  const titles = (body: { items: { title: string }[] }) => body.items.map((item) => item.title);
  const format = (name: string) => [{ name, descriptions: [] }];

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
    verifyIdToken.mockResolvedValue({ uid: "test-uid", email: "dp.ceolpan@gmail.com" });
  });

  afterEach(() => {
    queue.stop();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  describe("GET /releases", () => {
    it("lists every enriched release without the seller-specific fields", async () => {
      seedRelease(1, "Alpha", { country: "UK", genres: ["Rock"], artists: [{ id: 7, name: "Band" }] });

      const res = await get("/releases");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page: 1, pageSize: 50, total: 1, enrichedCount: 1, fadedCount: 0 });
      expect(res.body.items).toEqual([
        {
          releaseId: 1,
          title: "Alpha",
          thumb: null,
          year: 2000,
          country: "UK",
          genres: ["Rock"],
          styles: [],
          formats: [],
          ratingAverage: null,
          ratingCount: null,
          haves: null,
          wants: null,
          artists: [{ id: 7, name: "Band" }],
        },
      ]);
    });

    it("includes releases no seller lists any more", async () => {
      seedRelease(1, "Orphan");
      seedRelease(2, "Listed");
      const now = new Date();
      db.insert(sellerInventory)
        .values({ sellerUsername: "gone", releaseId: 2, status: "sold", firstSeenAt: now, lastSeenAt: now, soldAt: now })
        .run();

      const res = await get("/releases");
      expect(titles(res.body)).toEqual(["Listed", "Orphan"]);
      expect(res.body.total).toBe(2);
    });

    it("filters like the seller inventory", async () => {
      seedRelease(1, "A", { genres: ["Rock"], styles: ["Punk"], formats: format("Vinyl"), country: "UK", year: 1977 });
      seedRelease(2, "B", { genres: ["Jazz"], styles: ["Bop"], formats: format("CD"), country: "US", year: 1999 });
      seedRelease(3, "C", { genres: ["Rock", "Jazz"], styles: ["Fusion"], formats: format("Vinyl"), country: "US", year: 1985 });

      expect(titles((await get("/releases?genre=Jazz")).body)).toEqual(["B", "C"]);
      expect(titles((await get("/releases?excludeGenre=Jazz")).body)).toEqual(["A"]);
      expect(titles((await get("/releases?onlyGenre=Rock")).body)).toEqual(["A"]);
      expect(titles((await get("/releases?style=Punk,Bop")).body)).toEqual(["A", "B"]);
      expect(titles((await get("/releases?format=Vinyl&country=US")).body)).toEqual(["C"]);
      expect(titles((await get("/releases?yearMin=1980&yearMax=1990")).body)).toEqual(["C"]);

      const filtered = await get("/releases?genre=Jazz");
      expect(filtered.body.total).toBe(2);
      expect(filtered.body.enrichedCount).toBe(3);
    });

    it("sorts, with the descending prefix and unrated releases last", async () => {
      seedRelease(1, "B", { year: 1990, ratingAverage: 3 });
      seedRelease(2, "A", { year: 2000, ratingAverage: null });
      seedRelease(3, "C", { year: 1980, ratingAverage: 4.5 });

      expect(titles((await get("/releases")).body)).toEqual(["A", "B", "C"]);
      expect(titles((await get("/releases?sort=-title")).body)).toEqual(["C", "B", "A"]);
      expect(titles((await get("/releases?sort=year")).body)).toEqual(["C", "B", "A"]);
      expect(titles((await get("/releases?sort=-rating")).body)).toEqual(["C", "B", "A"]);
      expect(titles((await get("/releases?sort=rating")).body)).toEqual(["B", "C", "A"]);
    });

    it("pages the results", async () => {
      for (let i = 1; i <= 5; i++) seedRelease(i, `R${i}`);

      const res = await get("/releases?page=2&pageSize=2");
      expect(titles(res.body)).toEqual(["R3", "R4"]);
      expect(res.body).toMatchObject({ page: 2, pageSize: 2, total: 5 });
    });

    it("leaves out faded releases, directly or through their master, and counts them", async () => {
      seedRelease(1, "Kept");
      seedRelease(2, "Faded release");
      seedRelease(3, "Faded by master", { masterId: 30 });
      const now = new Date();
      db.insert(fades)
        .values([
          { uid: "test-uid", kind: "release", id: 2, createdAt: now },
          { uid: "test-uid", kind: "master", id: 30, createdAt: now },
          { uid: "someone-else", kind: "release", id: 1, createdAt: now },
        ])
        .run();

      const res = await get("/releases");
      expect(titles(res.body)).toEqual(["Kept"]);
      expect(res.body).toMatchObject({ total: 1, enrichedCount: 3, fadedCount: 2 });
    });

    it.each([
      ["page=0", "page must be a positive integer"],
      ["page=x", "page must be a positive integer"],
      ["pageSize=0", "pageSize must be a positive integer"],
      ["yearMin=abc", "yearMin must be an integer"],
      ["yearMax=1.5", "yearMax must be an integer"],
      ["sort=bogus", "sort must be one of"],
    ])("400s on %s", async (query, message) => {
      const res = await get(`/releases?${query}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(message);
    });

    it("still serves GET /releases/:id", async () => {
      seedRelease(5, "Stored");
      const res = await get("/releases/5");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(5);
    });
  });

  describe("GET /releases/facets", () => {
    it("returns distinct values across all enriched releases, faded ones excluded", async () => {
      seedRelease(1, "R1", { country: "UK", genres: ["Rock", "Pop"], styles: ["Prog Rock"], formats: format("Vinyl") });
      seedRelease(2, "R2", { country: "US", genres: ["Rock"], styles: ["Indie Rock"], formats: format("CD") });
      seedRelease(3, "Faded", { country: "JP", genres: ["Jazz"], styles: ["Bop"], formats: format("Cassette") });
      db.insert(fades).values({ uid: "test-uid", kind: "release", id: 3, createdAt: new Date() }).run();

      const res = await get("/releases/facets");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        genres: ["Pop", "Rock"],
        styles: ["Indie Rock", "Prog Rock"],
        formats: ["CD", "Vinyl"],
        countries: ["UK", "US"],
      });
    });

    it("returns empty arrays when nothing is enriched", async () => {
      const res = await get("/releases/facets");
      expect(res.body).toEqual({ genres: [], styles: [], formats: [], countries: [] });
    });
  });
});
