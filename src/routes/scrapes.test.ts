import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Express } from "express";
import { createDb, type Db } from "../db/client";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { discogsTokens, releases } from "../db/schema";
import { DiscogsQueue, NonRetryableError } from "../queue/discogs-queue";
import { encryptToken } from "../util/token-crypto";
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

describe("scrapes", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;
  let app: Express;

  function seedRelease(id: number, title: string, artists: string[]) {
    db.insert(releases)
      .values({
        id,
        title,
        videos: [],
        tracklist: [],
        year: 2000,
        genres: [],
        styles: [],
        formats: [],
        labels: [],
        artists: artists.map((name, index) => ({ id: id * 10 + index, name })),
        masterId: null,
      })
      .run();
  }

  const upload = (uid: string, name: string, text: string) => asUser(app, uid).post("/scrapes").send({ name, text });

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

    seedRelease(1, "Last Rhythm", ["Last Rhythm"]);
    seedRelease(2, "Strange Things Happening", ["Primary Sequence"]);
    seedRelease(3, "Strange Things Happening", ["Primary Sequence"]);
    seedRelease(4, "Strange Things Happening", ["Someone Else"]);
    seedRelease(5, "Café Del Mar", ["The Chemical Brothers"]);
    seedRelease(6, "Two Of Us", ["Orbital", "Friend"]);
  });

  afterEach(() => {
    queue.stop();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  it("requires a signed-in user", async () => {
    expect((await request(app).get("/scrapes")).status).toBe(401);
  });

  it("matches lines to releases and lists the rest as unmatched", async () => {
    const res = await upload(
      "u1",
      "Disk Frisk",
      [
        "Last Rhythm - Last Rhythm",
        "primary sequence - strange things happening",
        "Chemical Brothers - Cafe del Mar",
        "Orbital & Friend - Two Of Us",
        "Nobody - Nothing Here",
        "no dash at all",
      ].join("\n"),
    );

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Disk Frisk", releaseCount: 5, unmatchedCount: 2 });

    const unmatched = await asUser(app, "u1").get(`/scrapes/${res.body.id}/unmatched`);
    expect(unmatched.body).toEqual({
      lines: [
        { position: 4, line: "Nobody - Nothing Here" },
        { position: 5, line: "no dash at all" },
      ],
    });
  });

  it("leaves a line unmatched when only a release flagged missing fits it", async () => {
    seedRelease(7, "Flagged Title", ["Gone Artist"]);
    db.update(releases).set({ missingAt: new Date() }).where(eq(releases.id, 7)).run();

    const res = await upload("u1", "Flagged", "Gone Artist - Flagged Title\nLast Rhythm - Last Rhythm");

    expect(res.body).toMatchObject({ releaseCount: 1, unmatchedCount: 1 });
    const unmatched = await asUser(app, "u1").get(`/scrapes/${res.body.id}/unmatched`);
    expect(unmatched.body.lines).toEqual([{ position: 0, line: "Gone Artist - Flagged Title" }]);
  });

  it("takes every pressing a line fits and no release of another artist", async () => {
    const created = await upload("u1", "Pressings", "Primary Sequence - Strange Things Happening");

    const list = await asUser(app, "u1").get(`/releases?scrape=${created.body.id}`);

    expect(list.body.items.map((item: { releaseId: number }) => item.releaseId)).toEqual([2, 3]);
  });

  it("lists a collector's scrapes, oldest first", async () => {
    await upload("u1", "First", "Last Rhythm - Last Rhythm");
    await upload("u1", "Second", "Nobody - Nothing");
    await upload("u2", "Theirs", "Last Rhythm - Last Rhythm");

    const res = await asUser(app, "u1").get("/scrapes");

    expect(res.body.map((scrape: { name: string }) => scrape.name)).toEqual(["First", "Second"]);
  });

  it("blocks a name the collector already uses, but not another collector's", async () => {
    await upload("u1", "Disk Frisk", "Last Rhythm - Last Rhythm");

    expect((await upload("u1", " Disk Frisk ", "Last Rhythm - Last Rhythm")).status).toBe(409);
    expect((await upload("u2", "Disk Frisk", "Last Rhythm - Last Rhythm")).status).toBe(201);
  });

  it("rejects an empty name, a missing or empty text and too many lines", async () => {
    expect((await upload("u1", "  ", "A - B")).status).toBe(400);
    expect((await asUser(app, "u1").post("/scrapes").send({ name: "x" })).status).toBe(400);
    expect((await upload("u1", "Blank", "\n \n")).status).toBe(400);
    const many = Array.from({ length: 5001 }, (_, i) => `Artist ${i} - Title`).join("\n");
    expect((await upload("u1", "Many", many)).status).toBe(400);
  });

  it("renames, refusing a name already in use", async () => {
    const first = await upload("u1", "First", "A - B");
    await upload("u1", "Second", "A - B");

    const renamed = await asUser(app, "u1").patch(`/scrapes/${first.body.id}`).send({ name: "Renamed" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Renamed");

    const taken = await asUser(app, "u1").patch(`/scrapes/${first.body.id}`).send({ name: "Second" });
    expect(taken.status).toBe(409);
  });

  it("deletes a scrape with its matches and unmatched lines", async () => {
    const created = await upload("u1", "Gone", "Last Rhythm - Last Rhythm\nNobody - Nothing");

    expect((await asUser(app, "u1").delete(`/scrapes/${created.body.id}`)).status).toBe(204);

    expect((await asUser(app, "u1").get("/scrapes")).body).toEqual([]);
    expect((await asUser(app, "u1").get(`/scrapes/${created.body.id}/unmatched`)).status).toBe(404);
    expect((await asUser(app, "u1").get(`/releases?scrape=${created.body.id}`)).body.total).toBe(0);
  });

  it("keeps one collector's scrape out of another's reach", async () => {
    const created = await upload("u1", "Private", "Last Rhythm - Last Rhythm");
    const id = created.body.id;

    expect((await asUser(app, "u2").get(`/scrapes/${id}/unmatched`)).status).toBe(404);
    expect((await asUser(app, "u2").patch(`/scrapes/${id}`).send({ name: "Mine" })).status).toBe(404);
    expect((await asUser(app, "u2").delete(`/scrapes/${id}`)).status).toBe(404);
    expect((await asUser(app, "u2").get(`/releases?scrape=${id}`)).body.total).toBe(0);
  });

  it("lets an enrichment run take just a scrape's releases", async () => {
    const created = await upload("u1", "To enrich", "Last Rhythm - Last Rhythm\nPrimary Sequence - Strange Things Happening");

    const preview = await asUser(app, "u1").get(`/enrichment/preview?query=${encodeURIComponent(`scrape=${created.body.id}`)}`);

    expect(preview.body).toMatchObject({ count: 3, skipped: 0 });
  });

  describe("attaching a release to an unmatched line", () => {
    const attach = (uid: string, scrapeId: number, position: number, releaseId: unknown) =>
      asUser(app, uid).post(`/scrapes/${scrapeId}/unmatched/${position}/attach`).send({ releaseId });

    it("moves the line from the unmatched list to the scrape's releases", async () => {
      const created = await upload("u1", "By hand", "Nobody - Nothing\nAlso - Missing");

      const res = await attach("u1", created.body.id, 0, 1);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ releaseCount: 1, unmatchedCount: 1 });
      const unmatched = await asUser(app, "u1").get(`/scrapes/${created.body.id}/unmatched`);
      expect(unmatched.body.lines).toEqual([{ position: 1, line: "Also - Missing" }]);
      const list = await asUser(app, "u1").get(`/releases?scrape=${created.body.id}`);
      expect(list.body.items.map((item: { releaseId: number }) => item.releaseId)).toEqual([1]);
    });

    it("does not count a release the scrape already holds twice", async () => {
      const created = await upload("u1", "Twice", "Last Rhythm - Last Rhythm\nNobody - Nothing");

      const res = await attach("u1", created.body.id, 1, 1);

      expect(res.body).toMatchObject({ releaseCount: 1, unmatchedCount: 0 });
    });

    it("refuses a bad id", async () => {
      const created = await upload("u1", "Unknown", "Nobody - Nothing");

      expect((await attach("u1", created.body.id, 0, "abc")).status).toBe(400);
      expect((await attach("u1", created.body.id, 0, 0)).status).toBe(400);
    });

    describe("a release the catalogue lacks or flags missing", () => {
      const fetched: number[] = [];

      beforeEach(() => {
        process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
        fetched.length = 0;
        // Stands in for Discogs: 500 is new, 8 is back after being flagged missing, anything else is a 404.
        queue.registerHandler("release_detail", async ({ releaseId }) => {
          fetched.push(releaseId);
          if (releaseId === 8) {
            db.update(releases).set({ missingAt: null }).where(eq(releases.id, 8)).run();
            return;
          }
          if (releaseId !== 500) throw new NonRetryableError("404");
          seedRelease(500, "Fetched From Discogs", ["Someone"]);
        });
        queue.start();
      });

      const saveToken = (uid: string) =>
        db
          .insert(discogsTokens)
          .values({ uid, tokenEncrypted: encryptToken("tok"), username: "dan", createdAt: new Date() })
          .run();

      it("fetches it from Discogs, stores it and attaches it", async () => {
        saveToken("u1");
        const created = await upload("u1", "Fetch", "Nobody - Nothing");

        const res = await attach("u1", created.body.id, 0, 500);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ releaseCount: 1, unmatchedCount: 0 });
        expect(fetched).toEqual([500]);
        expect((await asUser(app, "u1").get("/releases/500")).body.title).toBe("Fetched From Discogs");
        const list = await asUser(app, "u1").get(`/releases?scrape=${created.body.id}`);
        expect(list.body.items.map((item: { releaseId: number }) => item.releaseId)).toEqual([500]);
      });

      it("leaves the line and the catalogue as they were when Discogs has no such release", async () => {
        saveToken("u1");
        const created = await upload("u1", "Reject", "Nobody - Nothing");

        const res = await attach("u1", created.body.id, 0, 999);

        expect(res.status).toBe(404);
        expect(res.body.code).toBe("release_not_found");
        expect((await asUser(app, "u1").get("/releases/999")).status).toBe(404);
        expect((await asUser(app, "u1").get(`/scrapes/${created.body.id}/unmatched`)).body.lines).toEqual([
          { position: 0, line: "Nobody - Nothing" },
        ]);
        expect((await asUser(app, "u1").get("/scrapes")).body[0]).toMatchObject({ releaseCount: 0, unmatchedCount: 1 });
      });

      const flagMissing = (id: number) => db.update(releases).set({ missingAt: new Date() }).where(eq(releases.id, id)).run();

      it("checks a release flagged missing with Discogs again, and shows it once Discogs has it", async () => {
        saveToken("u1");
        seedRelease(8, "Came Back", ["Returned"]);
        flagMissing(8);
        const created = await upload("u1", "Flagged", "Nobody - Nothing");

        const res = await attach("u1", created.body.id, 0, 8);

        expect(res.status).toBe(200);
        expect(fetched).toEqual([8]);
        const list = await asUser(app, "u1").get(`/releases?scrape=${created.body.id}`);
        expect(list.body.items.map((item: { releaseId: number }) => item.releaseId)).toEqual([8]);
      });

      it("rejects a release flagged missing that Discogs still does not have", async () => {
        saveToken("u1");
        seedRelease(9, "Still Gone", ["Vanished"]);
        flagMissing(9);
        const created = await upload("u1", "Still flagged", "Nobody - Nothing");

        const res = await attach("u1", created.body.id, 0, 9);

        expect(res.status).toBe(404);
        expect(res.body.code).toBe("release_not_found");
        expect((await asUser(app, "u1").get("/scrapes")).body[0]).toMatchObject({ releaseCount: 0, unmatchedCount: 1 });
        expect(db.select().from(releases).where(eq(releases.id, 9)).get()!.missingAt).not.toBeNull();
      });

      it("asks for a Discogs token when the collector has none", async () => {
        const created = await upload("u1", "No token", "Nobody - Nothing");

        const res = await attach("u1", created.body.id, 0, 500);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe("token_required");
        expect(fetched).toEqual([]);
      });
    });

    it("404s for a line that is not unmatched or a scrape that is not the collector's", async () => {
      const created = await upload("u1", "Mine", "Last Rhythm - Last Rhythm\nNobody - Nothing");

      expect((await attach("u1", created.body.id, 0, 2)).status).toBe(404);
      expect((await attach("u2", created.body.id, 1, 2)).status).toBe(404);
    });
  });

  it("rejects a scrape filter that is not an integer", async () => {
    expect((await asUser(app, "u1").get("/releases?scrape=abc")).status).toBe(400);
  });
});
