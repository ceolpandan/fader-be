import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "../db/client";
import { discogsTokens, enrichmentNotFound, enrichmentRuns, releaseRaw, releases } from "../db/schema";
import { DiscogsNotFoundError, DiscogsTransientError } from "../discogs-client";
import { NonRetryableError } from "../queue/discogs-queue";
import type { DiscogsRelease } from "../types/discogs-api";
import { loadReleaseFixture } from "./__fixtures__/release-fixtures";
import { createReleaseDetailHandler, ReleaseMissingError } from "./release-detail-handler";

describe("release_detail handler", () => {
  let dbPath: string;
  let db: Db;
  const getRelease = vi.fn<(id: number, token: string) => Promise<DiscogsRelease>>();
  const getCurrency = vi.fn<(username: string, token: string) => Promise<string | null>>();

  beforeEach(() => {
    getCurrency.mockReset();
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    getRelease.mockReset();
    db.insert(releases)
      .values({
        id: 1,
        title: "Old title",
        genres: [],
        styles: [],
        formats: [],
        artists: [],
      })
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
      getCurrency,
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
    db.update(releases)
      .set({ missingAt: new Date(5) })
      .where(eq(releases.id, 1))
      .run();
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

  describe("price currency (fader-ui#154)", () => {
    const HOUR = 60 * 60 * 1000;
    /** A token whose currency was read `hoursAgo` hours ago (`null` currency: never read). */
    const saveToken = (currency: string | null = null, hoursAgo = 1) =>
      db
        .insert(discogsTokens)
        .values({
          uid: "u1",
          tokenEncrypted: "x",
          username: "alice",
          currency,
          currencyCheckedAt: currency ? new Date(Date.now() - hoursAgo * HOUR) : null,
          createdAt: new Date(),
        })
        .run();
    const token = () => db.select().from(discogsTokens).where(eq(discogsTokens.uid, "u1")).get();
    const tokenCurrency = () => token()?.currency;
    const run = () => handler()({ uid: "u1", releaseId: 1 }, { runId: "run1", jobId: 1 });

    it("asks Discogs for the account's currency once, keeps it on the token and stores it with the price", async () => {
      saveToken();
      getCurrency.mockResolvedValue("EUR");
      getRelease.mockResolvedValue(discogsRelease({ lowest_price: 12.5 }));

      await run();
      await run();

      expect(getCurrency).toHaveBeenCalledTimes(1);
      expect(getCurrency).toHaveBeenCalledWith("alice", "token-u1");
      expect(tokenCurrency()).toBe("EUR");
      expect(row()).toMatchObject({ lowestPrice: 12.5, lowestPriceCurrency: "EUR" });
    });

    it("stores the currency the token has read within the day, without asking Discogs", async () => {
      saveToken("USD", 23);
      getRelease.mockResolvedValue(discogsRelease({ lowest_price: 12.5 }));

      await run();

      expect(getCurrency).not.toHaveBeenCalled();
      expect(row()).toMatchObject({ lowestPrice: 12.5, lowestPriceCurrency: "USD" });
    });

    it("reads the currency again once it is a day old, and follows a currency changed on Discogs", async () => {
      saveToken("EUR", 25);
      getCurrency.mockResolvedValue("USD");
      getRelease.mockResolvedValue(discogsRelease({ lowest_price: 12.5 }));
      const before = Date.now();

      await run();

      expect(getCurrency).toHaveBeenCalledWith("alice", "token-u1");
      expect(tokenCurrency()).toBe("USD");
      expect(token()!.currencyCheckedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(row()).toMatchObject({ lowestPrice: 12.5, lowestPriceCurrency: "USD" });
    });

    it("keeps the currency when Discogs still says the same, and asks again only after another day", async () => {
      saveToken("EUR", 25);
      getCurrency.mockResolvedValue("EUR");
      getRelease.mockResolvedValue(discogsRelease({ lowest_price: 12.5 }));

      await run();
      await run();

      expect(getCurrency).toHaveBeenCalledTimes(1);
      expect(row()).toMatchObject({ lowestPriceCurrency: "EUR" });
    });

    it("lets a failed currency read fail the job, so no price is stored under a stale code", async () => {
      saveToken("EUR", 25);
      getCurrency.mockRejectedValue(new DiscogsTransientError("down"));
      getRelease.mockResolvedValue(discogsRelease({ lowest_price: 12.5 }));

      await expect(run()).rejects.toBeInstanceOf(DiscogsTransientError);

      expect(row().lowestPrice).toBeNull();
      expect(tokenCurrency()).toBe("EUR");
    });

    it("stores no currency for a release with no price, and replaces a stale one", async () => {
      saveToken("EUR");
      db.update(releases).set({ lowestPrice: 3, lowestPriceCurrency: "EUR" }).where(eq(releases.id, 1)).run();
      getRelease.mockResolvedValue(discogsRelease());

      await run();

      expect(row()).toMatchObject({ lowestPrice: null, lowestPriceCurrency: null });
    });

    it("stores the price with no currency when Discogs does not say, and asks again next time", async () => {
      saveToken();
      getCurrency.mockResolvedValue(null);
      getRelease.mockResolvedValue(discogsRelease({ lowest_price: 12.5 }));

      await run();

      expect(tokenCurrency()).toBeNull();
      expect(row()).toMatchObject({ lowestPrice: 12.5, lowestPriceCurrency: null });
    });

    it("does not ask for the currency of a release Discogs no longer has", async () => {
      saveToken();
      getRelease.mockRejectedValue(new DiscogsNotFoundError("gone"));

      await expect(
        handler()({ uid: "u1", releaseId: 1, once: true }, { runId: "inline-x", jobId: 1, attempt: 1 }),
      ).rejects.toBeInstanceOf(ReleaseMissingError);

      expect(getCurrency).not.toHaveBeenCalled();
    });
  });

  it("stores the cover thumbnail and the lowest price", async () => {
    getRelease.mockResolvedValue(
      discogsRelease({
        thumb: "https://i.discogs.com/t.jpg",
        lowest_price: 12.5,
      }),
    );

    await handler()({ uid: "u1", releaseId: 1 }, { runId: "run1", jobId: 1 });

    expect(row()).toMatchObject({
      thumb: "https://i.discogs.com/t.jpg",
      lowestPrice: 12.5,
    });
  });

  it("stores no thumbnail for an empty one, and no price for a release Discogs sent none for", async () => {
    db.update(releases).set({ thumb: "https://i.discogs.com/old.jpg", lowestPrice: 3 }).where(eq(releases.id, 1)).run();
    getRelease.mockResolvedValue(discogsRelease({ thumb: "" }));

    await handler()({ uid: "u1", releaseId: 1 }, { runId: "run1", jobId: 1 });

    expect(row()).toMatchObject({ thumb: null, lowestPrice: null });
  });

  it("keeps a lowest price of 0", async () => {
    getRelease.mockResolvedValue(discogsRelease({ lowest_price: 0 }));

    await handler()({ uid: "u1", releaseId: 1 }, { runId: "run1", jobId: 1 });

    expect(row().lowestPrice).toBe(0);
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

  describe("release_raw", () => {
    const raw = () => db.select().from(releaseRaw).where(eq(releaseRaw.releaseId, 1)).get();

    it("stores the stripped response with when it was fetched, in the same step as the row", async () => {
      getRelease.mockResolvedValue(
        discogsRelease({
          notes: "Hello",
          date_changed: "2024-01-01",
          master_url: "https://x/m",
          images: [],
        }),
      );

      await handler()({ uid: "u1", releaseId: 1 }, { runId: "run1", jobId: 1 });

      const body = JSON.parse(raw()!.body) as Record<string, unknown>;
      expect(body).toMatchObject({
        id: 1,
        notes: "Hello",
        date_changed: "2024-01-01",
      });
      expect(body).not.toHaveProperty("master_url");
      expect(body).not.toHaveProperty("images");
      expect(raw()!.body).not.toContain("resource_url");
      expect(raw()!.fetchedAt).toEqual(row().enrichedAt);
    });

    it("overwrites the stored response when date_changed differs", async () => {
      getRelease.mockResolvedValueOnce(discogsRelease({ date_changed: "2024-01-01", notes: "old" }));
      await handler()({ uid: "u1", releaseId: 1 }, { runId: "run1", jobId: 1 });
      getRelease.mockResolvedValueOnce(discogsRelease({ date_changed: "2024-02-02", notes: "new" }));
      await handler()({ uid: "u1", releaseId: 1 }, { runId: "run1", jobId: 1 });

      expect(JSON.parse(raw()!.body)).toMatchObject({
        date_changed: "2024-02-02",
        notes: "new",
      });
      expect(db.select().from(releaseRaw).all()).toHaveLength(1);
    });

    it("skips the write when date_changed equals the stored one, but still updates the row", async () => {
      getRelease.mockResolvedValueOnce(discogsRelease({ date_changed: "2024-01-01", notes: "first" }));
      await handler()({ uid: "u1", releaseId: 1 }, { runId: "run1", jobId: 1 });
      const first = raw()!;
      getRelease.mockResolvedValueOnce(
        discogsRelease({
          title: "Newer title",
          date_changed: "2024-01-01",
          notes: "second",
        }),
      );
      await handler()({ uid: "u1", releaseId: 1 }, { runId: "run1", jobId: 1 });

      expect(raw()).toEqual(first);
      expect(row().title).toBe("Newer title");
    });

    it("writes when the response has no date_changed", async () => {
      getRelease.mockResolvedValueOnce(discogsRelease({ notes: "first" }));
      await handler()({ uid: "u1", releaseId: 1 }, { runId: "run1", jobId: 1 });
      getRelease.mockResolvedValueOnce(discogsRelease({ notes: "second" }));
      await handler()({ uid: "u1", releaseId: 1 }, { runId: "run1", jobId: 1 });

      expect(JSON.parse(raw()!.body)).toMatchObject({ notes: "second" });
    });

    it("stores a real response as valid JSON equal to its reviewed stripped form", async () => {
      const { raw: fixture, stripped } = loadReleaseFixture(1894284);
      getRelease.mockResolvedValue(fixture);

      await handler()({ uid: "u1", releaseId: 1894284 }, { runId: "wantlist-availability:u1", jobId: 1 });

      const stored = db.select().from(releaseRaw).where(eq(releaseRaw.releaseId, 1894284)).get()!;
      expect(typeof stored.body).toBe("string");
      expect(JSON.parse(stored.body)).toEqual(stripped);
    });

    it("stores nothing for a release Discogs no longer has", async () => {
      getRelease.mockRejectedValue(new DiscogsNotFoundError("gone"));

      await expect(
        handler()({ uid: "u1", releaseId: 1, once: true }, { runId: "run1", jobId: 1 }),
      ).rejects.toBeInstanceOf(ReleaseMissingError);

      expect(raw()).toBeUndefined();
    });
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
    await expect(
      handler()({ uid: "u1", releaseId: 1 }, { runId: "run1", jobId: 1, attempt: 3 }),
    ).rejects.toBeInstanceOf(ReleaseMissingError);

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
