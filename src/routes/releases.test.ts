import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Express } from "express";
import { createDb, type Db } from "../db/client";
import { discogsQueueJobs, releases } from "../db/schema";
import { DiscogsNotFoundError } from "../discogs-client";
import { createReleaseDetailHandler } from "../indexing/release-detail-handler";
import { DEFAULT_WAIT_TIMEOUT_MS, DiscogsQueue, PACING_MS } from "../queue/discogs-queue";
import type { DiscogsRelease } from "../types/discogs-api";
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

const discogsRelease: DiscogsRelease = {
  id: 732194,
  resource_url: "https://api.discogs.com/releases/732194",
  title: "Stockholm",
  artists: [
    {
      id: 1,
      name: "The Persuader",
      anv: "",
      join: "",
      role: "",
      tracks: "",
      resource_url: "https://api.discogs.com/artists/1",
    },
  ],
  thumb: "https://example.com/thumb.jpg",
  year: 1998,
  country: "Sweden",
  genres: ["Electronic"],
  styles: ["Tech House", "Electro"],
  tracklist: [{ position: "A1", title: "Track One", duration: "5:00" }],
  videos: [{ uri: "https://youtube.com/x", title: "Track One (video)" }],
  labels: [{ id: 5, name: "Svek", catno: "SVEK001", entity_type: "1", resource_url: "https://x" }],
  notes: "not part of the trimmed DTO",
};

const expectedDto = {
  id: 732194,
  title: "Stockholm",
  thumb: "https://example.com/thumb.jpg",
  year: 1998,
  country: "Sweden",
  genres: ["Electronic"],
  styles: ["Tech House", "Electro"],
  artists: [{ id: 1, name: "The Persuader" }],
  tracklist: [{ position: "A1", title: "Track One", duration: "5:00" }],
  videos: [{ uri: "https://youtube.com/x", title: "Track One (video)" }],
};

describe("releases routes", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;
  let app: Express;
  const getRelease = vi.fn<(id: number) => Promise<DiscogsRelease>>();

  const get = (url: string) => request(app).get(url).set("Authorization", "Bearer test-token");
  const post = (url: string) => request(app).post(url).set("Authorization", "Bearer test-token");

  const nextTurns = async (turns: number) => {
    for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  // The HTTP request reaches the server over real IO, so wait until it has enqueued its job
  // before moving the fake clock — otherwise a queue tick can fire on an empty queue.
  async function untilJobEnqueued() {
    for (let i = 0; i < 200 && db.select().from(discogsQueueJobs).all().length === 0; i++) {
      await nextTurns(1);
    }
  }

  async function getWhileClockAdvances(url: string, advanceMs: number) {
    const pending = get(url).then((res) => res);
    await untilJobEnqueued();
    await vi.advanceTimersByTimeAsync(advanceMs);
    return pending;
  }

  async function postWhileClockAdvances(url: string, advanceMs: number) {
    const pending = post(url).then((res) => res);
    await untilJobEnqueued();
    await vi.advanceTimersByTimeAsync(advanceMs);
    return pending;
  }

  const seedStaleRelease = () =>
    db
      .insert(releases)
      .values({
        id: 732194,
        title: "Old Title",
        year: 1990,
        country: null,
        genres: [],
        styles: [],
        formats: [],
        thumb: "https://example.com/old.jpg",
        labelIds: [],
        artists: [{ id: 9, name: "Old Artist" }],
        tracklist: [{ position: "1", title: "Old Track" }],
        videos: [],
      })
      .run();

  const storedRelease = () =>
    db.select().from(releases).where(eq(releases.id, 732194)).get();

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    queue = new DiscogsQueue(db);
    getRelease.mockReset();
    queue.registerHandler("release_detail", createReleaseDetailHandler({ db, getRelease }));
    app = createApp({ db, queue });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    process.env.FIREBASE_PROJECT_ID = "test-project";
    process.env.FIREBASE_CLIENT_EMAIL = "test@test-project.iam.gserviceaccount.com";
    process.env.FIREBASE_PRIVATE_KEY = "test-key";
    process.env.ALLOWED_EMAILS = "dp.ceolpan@gmail.com";
    verifyIdToken.mockReset();
    verifyIdToken.mockResolvedValue({ uid: "test-uid", email: "dp.ceolpan@gmail.com" });
  });

  afterEach(() => {
    queue.stop();
    vi.useRealTimers();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  it("returns the trimmed DTO for a release already in the DB, without calling Discogs", async () => {
    db.insert(releases)
      .values({
        id: 732194,
        title: "Stockholm",
        year: 1998,
        country: "Sweden",
        genres: ["Electronic"],
        styles: ["Tech House", "Electro"],
        formats: [],
        thumb: "https://example.com/thumb.jpg",
        labelIds: [5],
        artists: [{ id: 1, name: "The Persuader" }],
        tracklist: expectedDto.tracklist,
        videos: expectedDto.videos,
      })
      .run();

    const res = await get("/releases/732194");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expectedDto);
    expect(getRelease).not.toHaveBeenCalled();
  });

  it("on a miss, fetches live through the queue, saves the release, and serves later requests from the DB", async () => {
    getRelease.mockResolvedValue(discogsRelease);
    queue.start();

    const res = await getWhileClockAdvances("/releases/732194", PACING_MS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expectedDto);
    expect(getRelease).toHaveBeenCalledTimes(1);

    const again = await get("/releases/732194");
    expect(again.body).toEqual(expectedDto);
    expect(getRelease).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when Discogs has no such release", async () => {
    getRelease.mockRejectedValue(new DiscogsNotFoundError("Discogs resource not found"));
    queue.start();

    const res = await getWhileClockAdvances("/releases/999999", PACING_MS);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Release not found" });
  });

  it("returns 502 when Discogs keeps failing until retries are exhausted", async () => {
    getRelease.mockRejectedValue(new Error("discogs is down"));
    queue.start();

    const res = await getWhileClockAdvances("/releases/732194", 15_000);

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Failed to fetch release from Discogs" });
  });

  it("returns 504 when the queue does not get to the job in time", async () => {
    // Queue never started: the job sits pending until the wait deadline passes.
    const res = await getWhileClockAdvances("/releases/732194", DEFAULT_WAIT_TIMEOUT_MS);

    expect(res.status).toBe(504);
    expect(res.body).toEqual({ error: "Timed out waiting for release from Discogs" });
  });

  it("returns 400 for a non-integer id", async () => {
    const res = await get("/releases/not-a-number");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "id must be an integer" });
  });

  describe("POST /releases/:id/refresh", () => {
    it("overwrites a stale stored release from live Discogs and returns the fresh DTO", async () => {
      seedStaleRelease();
      getRelease.mockResolvedValue(discogsRelease);
      queue.start();

      const res = await postWhileClockAdvances("/releases/732194/refresh", PACING_MS);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(expectedDto);
      expect(getRelease).toHaveBeenCalledTimes(1);
      expect(storedRelease()).toMatchObject({
        title: "Stockholm",
        year: 1998,
        genres: ["Electronic"],
        styles: ["Tech House", "Electro"],
        thumb: "https://example.com/thumb.jpg",
        artists: [{ id: 1, name: "The Persuader" }],
        tracklist: expectedDto.tracklist,
        videos: expectedDto.videos,
      });
    });

    it("creates the release when it is not stored yet", async () => {
      getRelease.mockResolvedValue(discogsRelease);
      queue.start();

      const res = await postWhileClockAdvances("/releases/732194/refresh", PACING_MS);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(expectedDto);
      expect(storedRelease()?.title).toBe("Stockholm");
    });

    it("returns 404 when Discogs has no such release, leaving the stored row untouched", async () => {
      seedStaleRelease();
      getRelease.mockRejectedValue(new DiscogsNotFoundError("Discogs resource not found"));
      queue.start();

      const res = await postWhileClockAdvances("/releases/732194/refresh", PACING_MS);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Release not found" });
      expect(storedRelease()?.title).toBe("Old Title");
    });

    it("returns 502 when Discogs keeps failing, leaving the stored row untouched", async () => {
      seedStaleRelease();
      getRelease.mockRejectedValue(new Error("discogs is down"));
      queue.start();

      const res = await postWhileClockAdvances("/releases/732194/refresh", 15_000);

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "Failed to fetch release from Discogs" });
      expect(storedRelease()?.title).toBe("Old Title");
    });

    it("returns 504 when the queue does not get to the job in time", async () => {
      seedStaleRelease();

      const res = await postWhileClockAdvances("/releases/732194/refresh", DEFAULT_WAIT_TIMEOUT_MS);

      expect(res.status).toBe(504);
      expect(res.body).toEqual({ error: "Timed out waiting for release from Discogs" });
    });

    it("coalesces concurrent refreshes of the same release into one Discogs call", async () => {
      seedStaleRelease();
      getRelease.mockResolvedValue(discogsRelease);
      queue.start();

      const first = post("/releases/732194/refresh").then((res) => res);
      const second = post("/releases/732194/refresh").then((res) => res);
      await untilJobEnqueued();
      await nextTurns(50); // let the second request reach the server before the clock moves
      await vi.advanceTimersByTimeAsync(PACING_MS * 2);
      const [a, b] = await Promise.all([first, second]);

      expect(a.body).toEqual(expectedDto);
      expect(b.body).toEqual(expectedDto);
      expect(getRelease).toHaveBeenCalledTimes(1);
    });

    it("returns 400 for a non-integer id", async () => {
      const res = await post("/releases/not-a-number/refresh");

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "id must be an integer" });
    });
  });
});
