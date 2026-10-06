import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "../db/client";
import { releases, scanPasses, sellerInventory, sellers } from "../db/schema";
import { DiscogsPaginationCapError } from "../discogs-client";
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

    expect(getInventory).toHaveBeenCalledWith("some-seller", 1, { sort: "artist", order: "asc" });
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
      payload: { username: "some-seller", page: 2, runStartedAt: RUN_STARTED, sort: "artist", order: "asc" },
    });
    expect(sellerRow().scanCompletedAt).toBeNull();
  });

  it("records the inventory total and the pages to scan (both passes) from page 1, and the page reached", async () => {
    const handler = createInventoryPageHandler({
      db,
      enqueue,
      getInventory: async () => inventoryPage(1, 423, [1], 42_223),
    });

    await handler({ username: "some-seller", page: 1, runStartedAt: RUN_STARTED }, ctx);

    expect(sellerRow()).toMatchObject({
      inventoryTotal: 42_223,
      scanPagesTotal: 200,
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

  describe("two-pass scan past the 10,000 item cap", () => {
    const passRows = () => db.select().from(scanPasses).all();
    const enqueuedPages = () => enqueue.mock.calls.map(([job]) => job).filter((job) => job.type === "inventory_page");

    it("plans both passes' pages up front when the inventory exceeds the cap", async () => {
      const handler = createInventoryPageHandler({
        db,
        enqueue,
        getInventory: async () => inventoryPage(1, 423, [1], 42_223),
      });

      await handler({ username: "some-seller", page: 1, runStartedAt: RUN_STARTED }, ctx);

      expect(sellerRow().scanPagesTotal).toBe(200);
      expect(passRows()).toMatchObject([
        { sort: "artist", order: "asc", pagesPlanned: 100, pagesFetched: 1, itemsSeen: 1, itemsNew: 1, status: "running" },
      ]);
    });

    it("plans only the pages the ascending pass left out when the inventory is just over the cap", async () => {
      const handler = createInventoryPageHandler({
        db,
        enqueue,
        getInventory: async () => inventoryPage(1, 150, [1], 10_250),
      });

      await handler({ username: "some-seller", page: 1, runStartedAt: RUN_STARTED }, ctx);

      expect(sellerRow().scanPagesTotal).toBe(103);
    });

    it("starts the descending pass after ascending page 100, without enriching yet", async () => {
      const handler = createInventoryPageHandler({
        db,
        enqueue,
        getInventory: async (_u, page) => inventoryPage(page, 423, [page], 42_223),
      });
      await handler({ username: "some-seller", page: 1, runStartedAt: RUN_STARTED }, ctx);
      enqueue.mockClear();

      await handler({ username: "some-seller", page: 100, runStartedAt: RUN_STARTED }, ctx);

      expect(enqueue.mock.calls.map(([job]) => job)).toEqual([
        {
          runId: "run-1",
          type: "inventory_page",
          payload: { username: "some-seller", page: 1, runStartedAt: RUN_STARTED, sort: "artist", order: "desc" },
        },
      ]);
      expect(passRows()[0]).toMatchObject({ order: "asc", status: "done", endedAt: expect.any(Date) });
      expect(sellerRow().scanCompletedAt).toBeNull();
    });

    it("fetches the descending pass with its own sort order and ends it after the pages it planned", async () => {
      const getInventory = vi.fn(async (_u: string, page: number) => inventoryPage(page, 150, [1000 + page], 10_250));
      const handler = createInventoryPageHandler({ db, enqueue, getInventory });
      await handler({ username: "some-seller", page: 1, runStartedAt: RUN_STARTED }, ctx);
      db.update(scanPasses).set({ status: "done" }).run();
      enqueue.mockClear();

      for (let page = 1; page <= 3; page += 1) {
        await handler({ username: "some-seller", page, runStartedAt: RUN_STARTED, sort: "artist", order: "desc" }, ctx);
      }

      expect(getInventory).toHaveBeenLastCalledWith("some-seller", 3, { sort: "artist", order: "desc" });
      expect(enqueuedPages().map((job) => (job.payload as { page: number }).page)).toEqual([2, 3]);
      expect(passRows().find((row) => row.order === "desc")).toMatchObject({
        pagesPlanned: 3,
        pagesFetched: 3,
        status: "done",
      });
      expect(enqueue.mock.calls.filter(([job]) => job.type === "release_detail")).toHaveLength(3);
      expect(sellerRow().scanCompletedAt).not.toBeNull();
    });

    it("counts a release both passes see once as new, and enriches it once", async () => {
      knownRelease(2);
      const handler = createInventoryPageHandler({
        db,
        enqueue,
        getInventory: async (_u, page, scan) =>
          scan.order === "asc" ? inventoryPage(page, 1, [1, 2], 10_100) : inventoryPage(page, 1, [2, 3], 10_100),
      });

      await handler({ username: "some-seller", page: 1, runStartedAt: RUN_STARTED }, ctx);
      await handler({ username: "some-seller", page: 1, runStartedAt: RUN_STARTED, order: "desc" }, ctx);

      const rows = passRows();
      expect(rows.find((r) => r.order === "asc")).toMatchObject({ itemsSeen: 2, itemsNew: 2 });
      expect(rows.find((r) => r.order === "desc")).toMatchObject({ itemsSeen: 2, itemsNew: 1 });
      const enriched = enqueue.mock.calls.map(([job]) => job).filter((job) => job.type === "release_detail");
      expect(enriched.map((job) => job.payload)).toEqual([{ releaseId: 1 }, { releaseId: 3 }]);
    });

    it("ends the pass cleanly, without failing, when Discogs refuses to paginate", async () => {
      const handler = createInventoryPageHandler({
        db,
        enqueue,
        getInventory: async (_u, page) => {
          if (page === 2) throw new DiscogsPaginationCapError("Pagination above 100 disabled");
          return inventoryPage(page, 423, [page], 5_000);
        },
      });
      await handler({ username: "some-seller", page: 1, runStartedAt: RUN_STARTED }, ctx);
      enqueue.mockClear();

      await expect(
        handler({ username: "some-seller", page: 2, runStartedAt: RUN_STARTED }, ctx),
      ).resolves.toBeUndefined();

      expect(passRows()[0]).toMatchObject({ status: "capped", endedAt: expect.any(Date) });
      expect(sellerRow().scanCompletedAt).not.toBeNull();
    });

    it("still fails the job when Discogs refuses for any other reason", async () => {
      const handler = createInventoryPageHandler({
        db,
        enqueue,
        getInventory: async () => {
          throw new Error("boom");
        },
      });

      await expect(
        handler({ username: "some-seller", page: 1, runStartedAt: RUN_STARTED }, ctx),
      ).rejects.toThrow("boom");
    });
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
