import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "../db/client";
import { releases } from "../db/schema";
import type { DiscogsRelease } from "../types/discogs-api";
import { DiscogsNotFoundError } from "../discogs-client";
import { NonRetryableError } from "../queue/discogs-queue";
import { createReleaseDetailHandler } from "./release-detail-handler";

const rawRelease: DiscogsRelease = {
  id: 732194,
  status: "Accepted",
  year: 1998,
  resource_url: "https://api.discogs.com/releases/732194",
  uri: "https://www.discogs.com/release/732194",
  artists: [
    {
      id: 1,
      name: "The Persuader",
      anv: "Persuader",
      join: "",
      role: "",
      tracks: "",
      resource_url: "https://api.discogs.com/artists/1",
    },
  ],
  labels: [
    {
      id: 5,
      name: "Svek",
      catno: "SVEK001",
      entity_type: "1",
      resource_url: "https://api.discogs.com/labels/5",
    },
  ],
  formats: [{ name: "Vinyl", qty: "2", descriptions: ["12\"", "33 1/3 RPM"] }],
  community: {
    have: 100,
    want: 50,
    rating: { count: 20, average: 4.5 },
    data_quality: "Needs Vote",
  },
  master_id: 12345,
  master_url: "https://api.discogs.com/masters/12345",
  title: "Stockholm",
  country: "Sweden",
  genres: ["Electronic"],
  styles: ["Deep House"],
  thumb: "https://example.com/thumb.jpg",
  notes: "some notes",
  videos: [{ uri: "https://youtube.com/x" }],
  identifiers: [{ type: "Matrix", value: "ABC" }],
  companies: [
    { id: 9, name: "Some Co", entity_type: "23", resource_url: "https://api.discogs.com/labels/9" },
  ],
  estimated_weight: 140,
  data_quality: "Needs Vote",
  released_formatted: "1998",
  tracklist: [{ position: "A1", title: "Track One", duration: "5:00" }],
  extraartists: [{ id: 2, name: "Extra Artist", resource_url: "https://api.discogs.com/artists/2" }],
  images: [{ type: "primary", uri: "https://x", resource_url: "https://x" }],
};

describe("release_detail handler", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
  });

  afterEach(() => {
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  it("maps exactly the spec'd fields into releases, dropping everything else", async () => {
    const getRelease = async () => rawRelease;
    const handler = createReleaseDetailHandler({ db, getRelease });

    await handler({ releaseId: 732194 }, { runId: "run-1", jobId: 1 });

    const [row] = db.select().from(releases).where(eq(releases.id, 732194)).all();

    expect(row).toEqual({
      id: 732194,
      title: "Stockholm",
      year: 1998,
      country: "Sweden",
      genres: ["Electronic"],
      styles: ["Deep House"],
      formats: [{ name: "Vinyl", descriptions: ["12\"", "33 1/3 RPM"] }],
      masterId: 12345,
      thumb: "https://example.com/thumb.jpg",
      ratingAverage: 4.5,
      ratingCount: 20,
      haves: 100,
      wants: 50,
      labelIds: [5],
      artists: [{ id: 1, name: "The Persuader" }],
    });
  });

  it("throws NonRetryableError (does not retry) on a 404 from Discogs", async () => {
    const getRelease = async () => {
      throw new DiscogsNotFoundError("Discogs resource not found: /releases/999999");
    };
    const handler = createReleaseDetailHandler({ db, getRelease });

    await expect(handler({ releaseId: 999999 }, { runId: "run-1", jobId: 1 })).rejects.toBeInstanceOf(
      NonRetryableError,
    );
  });

  it("propagates a transient error unchanged, so the queue's normal retry applies", async () => {
    const transientError = new Error("network blip");
    const getRelease = async () => {
      throw transientError;
    };
    const handler = createReleaseDetailHandler({ db, getRelease });

    await expect(handler({ releaseId: 732194 }, { runId: "run-1", jobId: 1 })).rejects.toBe(
      transientError,
    );
  });

  it("upserts (overwrites) a release row that already exists", async () => {
    db.insert(releases)
      .values({
        id: 732194,
        title: "Old Title",
        year: 1990,
        country: null,
        genres: [],
        styles: [],
        formats: [],
        labelIds: [],
        artists: [],
      })
      .run();

    const getRelease = async () => rawRelease;
    const handler = createReleaseDetailHandler({ db, getRelease });

    await handler({ releaseId: 732194 }, { runId: "run-1", jobId: 1 });

    const [row] = db.select().from(releases).where(eq(releases.id, 732194)).all();
    expect(row!.title).toBe("Stockholm");
    expect(row!.year).toBe(1998);
  });
});
