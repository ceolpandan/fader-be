import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Express } from "express";
import { createDb, type Db } from "../db/client";
import { releases } from "../db/schema";
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

const expectedDto = {
  id: 732194,
  title: "Stockholm",
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

  const get = (url: string) => request(app).get(url).set("Authorization", "Bearer test-token");

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

  it("returns the trimmed DTO for a release in the DB", async () => {
    db.insert(releases)
      .values({
        id: 732194,
        title: "Stockholm",
        year: 1998,
        country: "Sweden",
        genres: ["Electronic"],
        styles: ["Tech House", "Electro"],
        formats: [],
        labelIds: [5],
        artists: [{ id: 1, name: "The Persuader" }],
        tracklist: expectedDto.tracklist,
        videos: expectedDto.videos,
      })
      .run();

    const res = await get("/releases/732194");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expectedDto);
  });

  it("returns 404 for a release that is not in the DB", async () => {
    const res = await get("/releases/999999");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Release not found" });
  });

  it("returns 400 for a non-integer id", async () => {
    const res = await get("/releases/not-a-number");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "id must be an integer" });
  });

  it("has no refresh route", async () => {
    const res = await request(app)
      .post("/releases/732194/refresh")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(404);
  });
});
