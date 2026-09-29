import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
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
  tracklist: [{ position: "A1", title: "Track One", duration: "5:00" }],
  videos: [{ uri: "https://youtube.com/x", title: "Track One (video)" }],
  labels: [{ id: 5, name: "Svek", catno: "SVEK001", entity_type: "1", resource_url: "https://x" }],
  notes: "not part of the trimmed DTO",
};

const expectedDto = {
  id: 732194,
  title: "Stockholm",
  thumb: "https://example.com/thumb.jpg",
  artists: [{ id: 1, name: "The Persuader" }],
  tracklist: [{ position: "A1", title: "Track One", duration: "5:00" }],
  videos: [{ uri: "https://youtube.com/x", title: "Track One (video)" }],
};

describe("GET /releases/:id", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;
  let app: Express;
  const getRelease = vi.fn<(id: number) => Promise<DiscogsRelease>>();

  const get = (url: string) => request(app).get(url).set("Authorization", "Bearer test-token");

  // The HTTP request reaches the server over real IO, so wait until it has enqueued its job
  // before moving the fake clock — otherwise a queue tick can fire on an empty queue.
  async function getWhileClockAdvances(url: string, advanceMs: number) {
    const pending = get(url).then((res) => res);
    for (let i = 0; i < 200 && db.select().from(discogsQueueJobs).all().length === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await vi.advanceTimersByTimeAsync(advanceMs);
    return pending;
  }

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
        styles: [],
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
});
