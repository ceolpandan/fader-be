import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Express } from "express";
import { eq, inArray } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { rebuildFilterOptions } from "../db/filter-options";
import { fades, releases } from "../db/schema";
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

describe("GET /releases and /releases/filter-options", () => {
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
      masterId: number | null;
      videos: { src: string; title: string }[];
      tracklist: { position: string; title: string }[];
    }> = {},
  ) {
    db.insert(releases)
      .values({
        id,
        title,
        videos: overrides.videos ?? [],
        tracklist: overrides.tracklist ?? [],
        year: overrides.year ?? 2000,
        country: overrides.country ?? null,
        genres: overrides.genres ?? [],
        styles: overrides.styles ?? [],
        formats: overrides.formats ?? [],
        labels: [],
        artists: overrides.artists ?? [],
        masterId: overrides.masterId ?? null,
      })
      .run();
  }

  const markEnriched = (...ids: number[]) =>
    db.update(releases).set({ enrichedAt: new Date() }).where(inArray(releases.id, ids)).run();
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
    it("lists every release", async () => {
      seedRelease(1, "Alpha", { country: "UK", genres: ["Rock"], artists: [{ id: 7, name: "Band" }] });

      const res = await get("/releases");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page: 1, pageSize: 50, total: 1, fadedCount: 0 });
      expect(res.body.items).toEqual([
        {
          releaseId: 1,
          title: "Alpha",
          year: 2000,
          country: "UK",
          genres: ["Rock"],
          styles: [],
          formats: [],
          ratingAverage: null,
          ratingCount: null,
          artists: [{ id: 7, name: "Band" }],
          labels: [],
        },
      ]);
    });

    it("filters by noLinks: only keeps releases without video links, exclude drops them", async () => {
      seedRelease(1, "Linked", { videos: [{ src: "https://youtube.com/x", title: "x" }] });
      seedRelease(2, "Bare");

      expect(titles((await get("/releases?noLinks=only")).body)).toEqual(["Bare"]);
      expect(titles((await get("/releases?noLinks=exclude")).body)).toEqual(["Linked"]);
      expect((await get("/releases?noLinks=maybe")).status).toBe(400);
    });

    it("filters by genre, style, format, country and year", async () => {
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
      expect(filtered.body.enrichedCount).toBeUndefined();
    });

    it("searches the title and the artist names: every word must match, in any case", async () => {
      seedRelease(1, "Selected Ambient Works", { artists: [{ id: 1, name: "Aphex Twin" }] });
      seedRelease(2, "Drukqs", { artists: [{ id: 1, name: "Aphex Twin" }] });
      seedRelease(3, "Twin Peaks", { artists: [{ id: 2, name: "Angelo Badalamenti" }] });
      seedRelease(4, "Name", { artists: [{ id: 3, name: "Someone" }] });

      expect(titles((await get("/releases?q=aphex")).body)).toEqual(["Drukqs", "Selected Ambient Works"]);
      expect(titles((await get("/releases?q=twin ambient")).body)).toEqual(["Selected Ambient Works"]);
      expect(titles((await get("/releases?q=TWIN")).body)).toEqual(["Drukqs", "Selected Ambient Works", "Twin Peaks"]);
      // The JSON keys of the stored artists are not searchable.
      expect(titles((await get("/releases?q=id")).body)).toEqual([]);
      expect(titles((await get("/releases?q=50%25")).body)).toEqual([]);
      expect(titles((await get("/releases?q=%20")).body)).toHaveLength(4);
      expect((await get(`/releases?q=${"a".repeat(201)}`)).status).toBe(400);
    });

    it("keeps only enriched releases with enriched=only, and counts them whatever the other filters", async () => {
      seedRelease(1, "Rock enriched", { genres: ["Rock"] });
      seedRelease(2, "Jazz enriched", { genres: ["Jazz"] });
      seedRelease(3, "Rock never", { genres: ["Rock"] });
      seedRelease(4, "Faded enriched");
      seedRelease(5, "Missing enriched");
      markEnriched(1, 2, 4, 5);
      db.insert(fades).values({ uid: "test-uid", kind: "release", id: 4, createdAt: new Date() }).run();
      db.update(releases).set({ missingAt: new Date() }).where(eq(releases.id, 5)).run();

      const all = await get("/releases?enriched=only");
      expect(titles(all.body)).toEqual(["Jazz enriched", "Rock enriched"]);
      expect(all.body.enrichedCount).toBe(2);

      const rock = await get("/releases?enriched=only&genre=Rock&q=enriched");
      expect(titles(rock.body)).toEqual(["Rock enriched"]);
      expect(rock.body).toMatchObject({ total: 1, enrichedCount: 2 });

      expect((await get("/releases")).body.enrichedCount).toBeUndefined();
      expect((await get("/releases?enriched=all")).status).toBe(400);
    });

    it("sorts, with the descending prefix", async () => {
      seedRelease(1, "B", { year: 1990 });
      seedRelease(2, "A", { year: 2000 });
      seedRelease(3, "C", { year: 1980 });

      expect(titles((await get("/releases")).body)).toEqual(["A", "B", "C"]);
      expect(titles((await get("/releases?sort=-title")).body)).toEqual(["C", "B", "A"]);
      expect(titles((await get("/releases?sort=year")).body)).toEqual(["C", "B", "A"]);
      expect((await get("/releases?sort=nonsense")).status).toBe(400);
    });

    it("sorts by rating, with releases that were never enriched last either way", async () => {
      seedRelease(1, "Low");
      seedRelease(2, "Never");
      seedRelease(3, "High");
      db.update(releases).set({ ratingAverage: 2.5, ratingCount: 10 }).where(eq(releases.id, 1)).run();
      db.update(releases).set({ ratingAverage: 4.5, ratingCount: 99 }).where(eq(releases.id, 3)).run();

      expect(titles((await get("/releases?sort=-rating")).body)).toEqual(["High", "Low", "Never"]);
      expect(titles((await get("/releases?sort=rating")).body)).toEqual(["Low", "High", "Never"]);
      const first = (await get("/releases?sort=-rating")).body.items[0];
      expect(first).toMatchObject({ ratingAverage: 4.5, ratingCount: 99 });
    });

    it("sorts by track count, with releases that have no tracklist last", async () => {
      const track = (n: number) => ({ position: String(n), title: `T${n}` });
      seedRelease(1, "Two", { tracklist: [track(1), track(2)] });
      seedRelease(2, "None");
      seedRelease(3, "Five", { tracklist: [1, 2, 3, 4, 5].map(track) });

      expect(titles((await get("/releases?sort=tracks")).body)).toEqual(["Two", "Five", "None"]);
      expect(titles((await get("/releases?sort=-tracks")).body)).toEqual(["Five", "Two", "None"]);
    });

    it("filters by track count, with 7+ meaning seven or more", async () => {
      const tracks = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ position: String(i + 1), title: `T${i + 1}` }));
      seedRelease(1, "One", { tracklist: tracks(1) });
      seedRelease(2, "Three", { tracklist: tracks(3) });
      seedRelease(3, "Seven", { tracklist: tracks(7) });
      seedRelease(4, "Twelve", { tracklist: tracks(12) });

      expect(titles((await get("/releases?tracks=3")).body)).toEqual(["Three"]);
      expect(titles((await get("/releases?tracks=1,7%2B")).body)).toEqual(["One", "Seven", "Twelve"]);
      expect((await get("/releases?tracks=8")).status).toBe(400);
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
      expect(res.body).toMatchObject({ total: 1, fadedCount: 2 });
    });

    it("hides releases an enrichment run found missing from the list and every count", async () => {
      seedRelease(1, "Kept");
      seedRelease(2, "Missing");
      seedRelease(3, "Missing and faded");
      const now = new Date();
      db.update(releases).set({ missingAt: now }).where(inArray(releases.id, [2, 3])).run();
      db.insert(fades).values({ uid: "test-uid", kind: "release", id: 3, createdAt: now }).run();

      const res = await get("/releases");

      expect(titles(res.body)).toEqual(["Kept"]);
      expect(res.body).toMatchObject({ total: 1, fadedCount: 0 });
    });

    it("shows a release again once it is no longer missing", async () => {
      seedRelease(1, "Back");
      db.update(releases).set({ missingAt: new Date() }).run();
      expect(titles((await get("/releases")).body)).toEqual([]);

      db.update(releases).set({ missingAt: null }).run();

      expect(titles((await get("/releases")).body)).toEqual(["Back"]);
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

  describe("styleCombo", () => {
    function seedStyled() {
      seedRelease(1, "Minimal Electro", { styles: ["Minimal", "Electro"] });
      seedRelease(2, "Minimal Ambient", { styles: ["Minimal", "Ambient", "Dub"] });
      seedRelease(3, "Minimal only", { styles: ["Minimal"] });
      seedRelease(4, "Electro Ambient", { styles: ["Electro", "Ambient"] });
      seedRelease(5, "Untagged");
    }

    it("keeps releases that have every style of a combination", async () => {
      seedStyled();
      const res = await get("/releases?styleCombo=Minimal,Electro&sort=title");
      expect(titles(res.body)).toEqual(["Minimal Electro"]);
      expect(res.body.total).toBe(1);
    });

    it("keeps releases matching any of several combinations", async () => {
      seedStyled();
      const res = await get("/releases?styleCombo=Minimal,Electro&styleCombo=Minimal,Ambient&sort=title");
      expect(titles(res.body)).toEqual(["Minimal Ambient", "Minimal Electro"]);
      expect(res.body.total).toBe(2);
    });

    it("treats a one-style combination as a plain include", async () => {
      seedStyled();
      const res = await get("/releases?styleCombo=Dub");
      expect(titles(res.body)).toEqual(["Minimal Ambient"]);
    });

    it("drops empty combinations and dedupes identical ones in any order", async () => {
      seedStyled();
      const res = await get("/releases?styleCombo=&styleCombo=Electro,Minimal&styleCombo=Minimal,Electro");
      expect(titles(res.body)).toEqual(["Minimal Electro"]);
      expect((await get("/releases?styleCombo=")).body.total).toBe(5);
    });

    it("narrows on top of the other filters", async () => {
      seedStyled();
      const res = await get("/releases?styleCombo=Minimal,Ambient&styleCombo=Electro,Ambient&excludeStyle=Dub");
      expect(titles(res.body)).toEqual(["Electro Ambient"]);
    });
  });

  describe("GET /releases/filter-options", () => {
    it("lists the values of each category, most common first, whatever the filters or fades", async () => {
      seedRelease(1, "R1", { country: "UK", genres: ["Rock", "Pop"], styles: ["Prog Rock"], formats: format("Vinyl") });
      seedRelease(2, "R2", { country: "US", genres: ["Rock"], styles: ["Indie Rock", "Prog Rock"], formats: format("Vinyl") });
      seedRelease(3, "Faded", { country: "UK", genres: ["Jazz"], styles: ["Bop"], formats: format("Cassette") });
      db.insert(fades).values({ uid: "test-uid", kind: "release", id: 3, createdAt: new Date() }).run();
      rebuildFilterOptions(db.$client);

      const res = await get("/releases/filter-options");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        genres: ["Rock", "Jazz", "Pop"],
        styles: ["Prog Rock", "Bop", "Indie Rock"],
        formats: ["Vinyl", "Cassette"],
        countries: ["UK", "US"],
      });
    });

    it("returns empty arrays when there are no options", async () => {
      const res = await get("/releases/filter-options");
      expect(res.body).toEqual({ genres: [], styles: [], formats: [], countries: [] });
    });

    it("serves the same lists with enriched=only, whatever is enriched", async () => {
      seedRelease(1, "R1", { country: "UK", genres: ["Rock"], styles: ["Prog Rock"], formats: format("Vinyl") });
      seedRelease(2, "Never", { country: "FR", genres: ["Jazz"], styles: ["Bop"], formats: format("Cassette") });
      markEnriched(1);
      rebuildFilterOptions(db.$client);

      const all = await get("/releases/filter-options");
      const enriched = await get("/releases/filter-options?enriched=only");
      expect(enriched.status).toBe(200);
      expect(enriched.body).toEqual(all.body);
      expect(enriched.body.genres).toEqual(expect.arrayContaining(["Rock", "Jazz"]));
    });

  });
});
