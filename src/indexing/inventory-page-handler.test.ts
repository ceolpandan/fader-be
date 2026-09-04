import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "../db/client";
import { releases, sellerInventory } from "../db/schema";
import type { DiscogsInventoryPage } from "../types/discogs-api";
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

  it("upserts seller_inventory and enqueues release_detail for a new, not-yet-known release, on a single-page (last) inventory", async () => {
    const page: DiscogsInventoryPage = {
      pagination: { page: 1, pages: 1, per_page: 100, items: 1, urls: {} },
      listings: [listing(732194)],
    };
    const getInventory = vi.fn(async () => page);

    const handler = createInventoryPageHandler({ db, enqueue, getInventory });

    await handler(
      { username: "some-seller", page: 1, runStartedAt: "2026-01-01T00:00:00.000Z" },
      { runId: "run-1", jobId: 1 },
    );

    expect(getInventory).toHaveBeenCalledWith("some-seller", 1);

    const [row] = db
      .select()
      .from(sellerInventory)
      .where(
        and(eq(sellerInventory.sellerUsername, "some-seller"), eq(sellerInventory.releaseId, 732194)),
      )
      .all();
    expect(row).toEqual({
      sellerUsername: "some-seller",
      releaseId: 732194,
      status: "active",
      firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
      lastSeenAt: new Date("2026-01-01T00:00:00.000Z"),
      soldAt: null,
    });

    expect(enqueue).toHaveBeenCalledWith({
      runId: "run-1",
      type: "release_detail",
      payload: { releaseId: 732194 },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue release_detail for a release id already present in releases", async () => {
    db.insert(releases)
      .values({
        id: 732194,
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

    const page: DiscogsInventoryPage = {
      pagination: { page: 1, pages: 1, per_page: 100, items: 1, urls: {} },
      listings: [listing(732194)],
    };
    const getInventory = vi.fn(async () => page);
    const handler = createInventoryPageHandler({ db, enqueue, getInventory });

    await handler(
      { username: "some-seller", page: 1, runStartedAt: "2026-01-01T00:00:00.000Z" },
      { runId: "run-1", jobId: 1 },
    );

    expect(enqueue).not.toHaveBeenCalled();

    const [row] = db
      .select()
      .from(sellerInventory)
      .where(
        and(eq(sellerInventory.sellerUsername, "some-seller"), eq(sellerInventory.releaseId, 732194)),
      )
      .all();
    expect(row!.status).toBe("active");
  });

  it("chains to the next page when the response has a next link, without running the sold-diff pass", async () => {
    const page: DiscogsInventoryPage = {
      pagination: {
        page: 1,
        pages: 2,
        per_page: 100,
        items: 2,
        urls: { next: "https://api.discogs.com/users/some-seller/inventory?page=2" },
      },
      listings: [listing(732194)],
    };
    const getInventory = vi.fn(async () => page);
    const handler = createInventoryPageHandler({ db, enqueue, getInventory });

    await handler(
      { username: "some-seller", page: 1, runStartedAt: "2026-01-01T00:00:00.000Z" },
      { runId: "run-1", jobId: 1 },
    );

    expect(enqueue).toHaveBeenCalledWith({
      runId: "run-1",
      type: "inventory_page",
      payload: { username: "some-seller", page: 2, runStartedAt: "2026-01-01T00:00:00.000Z" },
    });
    // one release_detail (new release) + one chained inventory_page, no sold-diff side effects to verify here
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("marks a previously-active listing as sold if it's absent from this run's inventory (last page)", async () => {
    // simulate a listing seen by a previous run, before this run started
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

    // this run's inventory no longer contains release 999
    const page: DiscogsInventoryPage = {
      pagination: { page: 1, pages: 1, per_page: 100, items: 1, urls: {} },
      listings: [listing(732194)],
    };
    const getInventory = vi.fn(async () => page);
    const handler = createInventoryPageHandler({ db, enqueue, getInventory });

    await handler(
      { username: "some-seller", page: 1, runStartedAt: "2026-01-01T00:00:00.000Z" },
      { runId: "run-1", jobId: 1 },
    );

    const [soldRow] = db
      .select()
      .from(sellerInventory)
      .where(
        and(eq(sellerInventory.sellerUsername, "some-seller"), eq(sellerInventory.releaseId, 999)),
      )
      .all();
    expect(soldRow!.status).toBe("sold");
    expect(soldRow!.soldAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("flips a previously-sold listing back to active and clears sold_at if it's relisted", async () => {
    db.insert(sellerInventory)
      .values({
        sellerUsername: "some-seller",
        releaseId: 732194,
        status: "sold",
        firstSeenAt: new Date("2025-11-01T00:00:00.000Z"),
        lastSeenAt: new Date("2025-11-15T00:00:00.000Z"),
        soldAt: new Date("2025-12-01T00:00:00.000Z"),
      })
      .run();

    const page: DiscogsInventoryPage = {
      pagination: { page: 1, pages: 1, per_page: 100, items: 1, urls: {} },
      listings: [listing(732194)],
    };
    const getInventory = vi.fn(async () => page);
    const handler = createInventoryPageHandler({ db, enqueue, getInventory });

    await handler(
      { username: "some-seller", page: 1, runStartedAt: "2026-01-01T00:00:00.000Z" },
      { runId: "run-1", jobId: 1 },
    );

    const [row] = db
      .select()
      .from(sellerInventory)
      .where(
        and(eq(sellerInventory.sellerUsername, "some-seller"), eq(sellerInventory.releaseId, 732194)),
      )
      .all();
    expect(row!.status).toBe("active");
    expect(row!.soldAt).toBeNull();
    expect(row!.firstSeenAt).toEqual(new Date("2025-11-01T00:00:00.000Z"));
  });
});
