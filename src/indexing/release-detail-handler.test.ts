import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "../db/client";
import { enrichmentNotFound, enrichmentRuns, releases } from "../db/schema";
import { DiscogsNotFoundError, DiscogsTransientError } from "../discogs-client";
import { NonRetryableError } from "../queue/discogs-queue";
import type { DiscogsRelease } from "../types/discogs-api";
import { createReleaseDetailHandler, ReleaseMissingError } from "./release-detail-handler";

describe("release_detail handler", () => {
  let dbPath: string;
  let db: Db;
  const getRelease = vi.fn<(id: number, token: string) => Promise<DiscogsRelease>>();

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    getRelease.mockReset();
    db.insert(releases)
      .values({ id: 1, title: "Old title", genres: [], styles: [], formats: [], artists: [] })
      .run();
    db.insert(enrichmentRuns)
      .values({
        id: "run1",
        uid: "u1",
        query: "",
        fresh: false,
        status: "running",
        total: 1,
        skipped: 0,
        startedAt: new Date(),
      })
      .run();
  });

  afterEach(() => {
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  const handler = () =>
    createReleaseDetailHandler({
      db,
      getToken: (uid) => (uid === "no-token" ? null : `token-${uid}`),
      getRelease,
    });
  const row = () => db.select().from(releases).where(eq(releases.id, 1)).get()!;
  const discogsRelease = (overrides: Partial<DiscogsRelease> = {}) =>
    ({
      id: 1,
      title: "New title",
      year: 1999,
      artists: [{ id: 7, name: "Band", resource_url: "" }],
      community: { rating: { average: 4.25, count: 12 }, have: 100, want: 50 },
      ...overrides,
    }) as DiscogsRelease;

  it("stores the release with its rating, using the collector's token, and clears a missing mark", async () => {
    db.update(releases).set({ missingAt: new Date(5) }).where(eq(releases.id, 1)).run();
    getRelease.mockResolvedValue(discogsRelease());

    await handler()({ uid: "u1", releaseId: 1 }, { runId: "run1", jobId: 1 });

    expect(getRelease).toHaveBeenCalledWith(1, "token-u1");
    expect(row()).toMatchObject({
      title: "New title",
      year: 1999,
      ratingAverage: 4.25,
      ratingCount: 12,
      missingAt: null,
      artists: [{ id: 7, name: "Band" }],
    });
    expect(row().enrichedAt).toBeInstanceOf(Date);
  });

  it("stores the number for sale and when it was fetched", async () => {
    getRelease.mockResolvedValue(discogsRelease({ num_for_sale: 7 }));

    await handler()({ uid: "u1", releaseId: 1 }, { runId: "run1", jobId: 1 });

    expect(row().numForSale).toBe(7);
    expect(row().numForSaleAt).toEqual(row().enrichedAt);
  });

  it("stores no count, but still when it was fetched, for a release Discogs sent none for", async () => {
    db.update(releases).set({ numForSale: 3 }).where(eq(releases.id, 1)).run();
    getRelease.mockResolvedValue(discogsRelease());

    await handler()({ uid: "u1", releaseId: 1 }, { runId: "run1", jobId: 1 });

    expect(row().numForSale).toBeNull();
    expect(row().numForSaleAt).toBeInstanceOf(Date);
  });

  it("inserts the full row for a release that is not stored, off any enrichment run", async () => {
    getRelease.mockResolvedValue(discogsRelease({ id: 9, num_for_sale: 0 }));

    await handler()({ uid: "u1", releaseId: 9 }, { runId: "wantlist-availability:u1", jobId: 1 });

    expect(db.select().from(releases).where(eq(releases.id, 9)).get()).toMatchObject({
      title: "New title",
      numForSale: 0,
      artists: [{ id: 7, name: "Band" }],
    });
  });

  it("stores a null rating for a release nobody rated", async () => {
    getRelease.mockResolvedValue(discogsRelease({ community: {} }));

    await handler()({ uid: "u1", releaseId: 1 }, { runId: "run1", jobId: 1 });

    expect(row()).toMatchObject({ ratingAverage: null, ratingCount: null });
    expect(row().enrichedAt).not.toBeNull();
  });

  it("fails without a token", async () => {
    await expect(handler()({ uid: "no-token", releaseId: 1 }, { runId: "run1", jobId: 1 })).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    expect(getRelease).not.toHaveBeenCalled();
  });

  it("retries a Discogs 404 until the last attempt, then marks the release missing and notes it on the run", async () => {
    getRelease.mockRejectedValue(new DiscogsNotFoundError("gone"));

    for (const attempt of [1, 2]) {
      await expect(handler()({ uid: "u1", releaseId: 1 }, { runId: "run1", jobId: 1, attempt })).rejects.toBeInstanceOf(
        DiscogsNotFoundError,
      );
      expect(row().missingAt).toBeNull();
    }
    await expect(handler()({ uid: "u1", releaseId: 1 }, { runId: "run1", jobId: 1, attempt: 3 })).rejects.toBeInstanceOf(
      ReleaseMissingError,
    );

    expect(row().missingAt).toBeInstanceOf(Date);
    expect(db.select().from(enrichmentNotFound).all()).toEqual([{ runId: "run1", releaseId: 1 }]);
  });

  it("marks the release missing at once for an inline refresh", async () => {
    getRelease.mockRejectedValue(new DiscogsNotFoundError("gone"));

    await expect(
      handler()({ uid: "u1", releaseId: 1, once: true }, { runId: "inline-x", jobId: 1, attempt: 1 }),
    ).rejects.toBeInstanceOf(ReleaseMissingError);

    expect(row().missingAt).toBeInstanceOf(Date);
    expect(db.select().from(enrichmentNotFound).all()).toEqual([]);
  });

  it("lets transient Discogs errors through for the queue to pause on", async () => {
    getRelease.mockRejectedValue(new DiscogsTransientError("down"));

    await expect(handler()({ uid: "u1", releaseId: 1 }, { runId: "run1", jobId: 1 })).rejects.toBeInstanceOf(
      DiscogsTransientError,
    );
    expect(row().enrichedAt).toBeNull();
  });
});
