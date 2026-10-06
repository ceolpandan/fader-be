import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "../db/client";
import { releases, sellerInventory, sellers } from "../db/schema";
import type { DiscogsInventoryPage, DiscogsUserProfile } from "../types/discogs-api";
import { createInventoryPageHandler } from "./inventory-page-handler";
import type { EnqueueInput } from "../queue/discogs-queue";

function listing(releaseId: number) {
  return {
    id: releaseId * 10,
    status: "For Sale",
    price: { currency: "USD", value: 20 },
    condition: "Mint (M)",
    seller: { username: "some-seller", resource_url: "", id: 1 },
    release: {
      id: releaseId,
      resource_url: `https://api.discogs.com/releases/${releaseId}`,
      description: "Some Release",
    },
    resource_url: "",
  };
}

describe("inventory_page handler", () => {
  let dbPath: string;
  let db: Db;
  let enqueue: ReturnType<typeof vi.fn<(job: EnqueueInput) => number>>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    enqueue = vi.fn<(job: EnqueueInput) => number>().mockReturnValue(1);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  const RUN_STARTED = "2026-01-01T00:00:00.000Z";
  const ctx = { runId: "run-1", jobId: 1 };
  const knownRelease = (id: number) =>
    db
      .insert(releases)
      .values({
        id,
        title: "Stockholm",
        year: 1998,
        country: "Sweden",
        genres: [],
        styles: [],
        formats: [],
        thumb: null,
        ratingAverage: null,
        ratingCount: null,
        haves: null,
        wants: null,
        labelIds: [],
        artists: [],
      })
      .run();
  const sellerRow = () => db.select().from(sellers).where(eq(sellers.username, "some-seller")).all()[0]!;
  const inventoryPage = (
    page: number,
    pages: number,
    releaseIds: number[],
    items = pages * 100,
  ): DiscogsInventoryPage => ({
    pagination: {
      page,
      pages,
      per_page: 100,
      items,
      urls: page < pages ? { next: `https://api.discogs.com/users/some-seller/inventory?page=${page + 1}` } : {},
    },
    listings: releaseIds.map(listing),
  });

  beforeEach(() => {
    db.insert(sellers)
      .values({ username: "some-seller", lastIndexStatus: "running", currentRunId: "run-1" })
      .run();
  });

  it("upserts seller_inventory but enqueues no release_detail while more pages remain", async () => {
    const getInventory = vi.fn(async () => inventoryPage(1, 2, [732194]));
    const handler = createInventoryPageHandler({ db, enqueue, getInventory });

    await handler({ username: "some-seller", page: 1, runStartedAt: RUN_STARTED }, ctx);

    expect(getInventory).toHaveBeenCalledWith("some-seller", 1);
    const [row] = db.select().from(sellerInventory).where(eq(sellerInventory.releaseId, 732194)).all();
    expect(row).toEqual({
      sellerUsername: "some-seller",
      releaseId: 732194,
      status: "active",
      firstSeenAt: new Date(RUN_STARTED),
      lastSeenAt: new Date(RUN_STARTED),
      soldAt: null,
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      runId: "run-1",
      type: "inventory_page",
      payload: { username: "some-seller", page: 2, runStartedAt: RUN_STARTED },
    });
    expect(sellerRow().scanCompletedAt).toBeNull();
  });

  it("records the inventory total and the pages to scan from page 1, and the page reached", async () => {
    const handler = createInventoryPageHandler({
      db,
      enqueue,
      getInventory: async () => inventoryPage(1, 423, [1], 42_223),
    });

    await handler({ username: "some-seller", page: 1, runStartedAt: RUN_STARTED }, ctx);

    expect(sellerRow()).toMatchObject({
      inventoryTotal: 42_223,
      scanPagesTotal: 100,
      scanPagesFetched: 1,
    });
  });

  it("on the last page, enqueues release_detail for every new release seen in the run and marks the scan complete", async () => {
    knownRelease(2);
    const handler = createInventoryPageHandler({
      db,
      enqueue,
      getInventory: async (_u, page) => (page === 1 ? inventoryPage(1, 2, [1, 2]) : inventoryPage(2, 2, [3])),
    });

    await handler({ username: "some-seller", page: 1, runStartedAt: RUN_STARTED }, ctx);
    enqueue.mockClear();
    await handler({ username: "some-seller", page: 2, runStartedAt: RUN_STARTED }, ctx);

    const queued = enqueue.mock.calls.map(([job]) => job);
    expect(queued).toEqual([
      { runId: "run-1", type: "release_detail", payload: { releaseId: 1 } },
      { runId: "run-1", type: "release_detail", payload: { releaseId: 3 } },
    ]);
    expect(sellerRow().scanCompletedAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("does not enqueue release_detail for releases already stored, but still links them to the seller", async () => {
    knownRelease(732194);
    const handler = createInventoryPageHandler({
      db,
      enqueue,
      getInventory: async () => inventoryPage(1, 1, [732194]),
    });

    await handler({ username: "some-seller", page: 1, runStartedAt: RUN_STARTED }, ctx);

    expect(enqueue).not.toHaveBeenCalled();
    const [row] = db.select().from(sellerInventory).where(eq(sellerInventory.releaseId, 732194)).all();
    expect(row!.status).toBe("active");
    expect(sellerRow().scanCompletedAt).not.toBeNull();
  });

  it("ignores listings from earlier runs that this run did not see", async () => {
    db.insert(sellerInventory)
      .values({
        sellerUsername: "some-seller",
        releaseId: 999,
        status: "active",
        firstSeenAt: new Date("2025-12-01T00:00:00.000Z"),
        lastSeenAt: new Date("2025-12-01T00:00:00.000Z"),
        soldAt: null,
      })
      .run();
    const handler = createInventoryPageHandler({
      db,
      enqueue,
      getInventory: async () => inventoryPage(1, 1, [732194]),
    });

    await handler({ username: "some-seller", page: 1, runStartedAt: RUN_STARTED }, ctx);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0].payload).toEqual({ releaseId: 732194 });
    const [untouched] = db.select().from(sellerInventory).where(eq(sellerInventory.releaseId, 999)).all();
    expect(untouched).toMatchObject({ status: "active", soldAt: null });
  });

  it("stops at the Discogs 100-page cap and finishes the scan instead of requesting page 101", async () => {
    const handler = createInventoryPageHandler({
      db,
      enqueue,
      getInventory: async (_u, page) => inventoryPage(page, 423, [page], 42_223),
    });

    await handler({ username: "some-seller", page: 100, runStartedAt: RUN_STARTED }, ctx);

    expect(enqueue.mock.calls.map(([job]) => job.type)).toEqual(["release_detail"]);
    expect(sellerRow().scanCompletedAt).not.toBeNull();
  });

  describe("seller metadata on page 1", () => {
    const runPage = (page: number, getUserProfile: (username: string) => Promise<DiscogsUserProfile>) => {
      const inventory: DiscogsInventoryPage = {
        pagination: { page, pages: 1, per_page: 100, items: 1, urls: {} },
        listings: [{ ...listing(732194), ships_from: "Germany" }],
      };
      const handler = createInventoryPageHandler({
        db,
        enqueue,
        getInventory: vi.fn(async () => inventory),
        getUserProfile,
      });
      return handler(
        { username: "some-seller", page, runStartedAt: "2026-01-01T00:00:00.000Z" },
        { runId: "run-1", jobId: 1 },
      );
    };

    it("stores rating and ships-from country", async () => {
      await runPage(1, async () => ({
        username: "some-seller",
        seller_rating: 96.4,
        seller_num_ratings: 174,
      }));

      expect(sellerRow()).toMatchObject({
        sellerRating: 96.4,
        sellerNumRatings: 174,
        shipsFromCountry: "Germany",
      });
    });

    it("still stores ships-from and does not fail when the profile fetch errors", async () => {
      await runPage(1, async () => {
        throw new Error("boom");
      });

      expect(sellerRow()).toMatchObject({
        sellerRating: null,
        sellerNumRatings: null,
        shipsFromCountry: "Germany",
      });
    });

    it("leaves seller metadata alone on later pages", async () => {
      await runPage(2, async () => ({ username: "some-seller", seller_rating: 50, seller_num_ratings: 1 }));

      expect(sellerRow().shipsFromCountry).toBeNull();
    });
  });
});
