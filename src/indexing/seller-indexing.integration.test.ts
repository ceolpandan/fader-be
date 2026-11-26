import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "../db/client";
import { discogsQueueJobs, fades, releases, scanPasses, sellerInventory, sellers } from "../db/schema";
import { DiscogsAuthError, DiscogsPaginationCapError } from "../discogs-client";
import { DiscogsQueue, PACING_MS } from "../queue/discogs-queue";
import type { DiscogsInventoryPage, DiscogsRelease } from "../types/discogs-api";
import { createInventoryPageHandler } from "./inventory-page-handler";
import { createReleaseDetailHandler } from "./release-detail-handler";
import { checkRunCompletion, markRunAborted } from "./run-completion";
import { createSellerProfileHandler } from "./seller-profile-handler";

/**
 * The whole chain on a real queue lane, as `index.ts` wires it, with Discogs faked: the profile
 * check, the scan pages, the fetching of unknown releases and the run's end.
 */
describe("seller indexing, end to end", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;

  const getUserProfile = vi.fn(async (username: string) => ({ username: username === "beta" ? "Beta" : username }));
  const getInventory = vi.fn<
    (username: string, page: number, scan: { sort: string; order: string }, token: string) => Promise<DiscogsInventoryPage>
  >();
  const getRelease = vi.fn(
    async (id: number) =>
      ({
        id,
        title: `Release ${id}`,
        year: 2000,
        artists: [{ id: 1, name: "Band", resource_url: "" }],
        community: { rating: { average: 4, count: 10 }, have: 5, want: 5 },
      }) as DiscogsRelease,
  );

  const listing = (releaseId: number) => ({
    id: releaseId * 10,
    status: "For Sale",
    price: { currency: "USD", value: 20 },
    condition: "Mint (M)",
    seller: { username: "Beta", resource_url: "", id: 1 },
    release: { id: releaseId, resource_url: "", description: `Release ${releaseId}` },
    resource_url: "",
  });
  const inventory = (releaseIds: number[], items = releaseIds.length): DiscogsInventoryPage => ({
    pagination: { page: 1, pages: 1, per_page: 100, items, urls: {} },
    listings: releaseIds.map(listing),
  });

  const seller = () => db.select().from(sellers).get()!;
  const settle = () => vi.advanceTimersByTimeAsync(PACING_MS * 30);

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    vi.useFakeTimers();
    getInventory.mockReset();
    getUserProfile.mockClear();
    getRelease.mockClear();

    queue = new DiscogsQueue(db);
    const getToken = (uid: string) => (uid === "u1" ? "token-u1" : null);
    queue.registerHandler(
      "seller_profile",
      createSellerProfileHandler({ db, enqueue: (job) => queue.enqueue(job), getToken, getUserProfile }),
    );
    queue.registerHandler(
      "inventory_page",
      createInventoryPageHandler({ db, enqueue: (job) => queue.enqueue(job), getToken, getInventory, getUserProfile }),
    );
    queue.registerHandler(
      "release_detail",
      createReleaseDetailHandler({ db, getToken, getRelease, getCurrency: async () => "EUR" }),
    );
    queue.onSettled((job) => checkRunCompletion(db, job.runId));
    queue.onRunAborted((runId) => markRunAborted(db, runId));
    queue.start();
  });

  afterEach(() => {
    queue.stop();
    vi.useRealTimers();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  const start = (uid = "u1") =>
    queue.enqueue({ runId: "run-1", type: "seller_profile", payload: { uid, username: "beta" } });

  it("indexes a seller: links the inventory, fetches the unknown releases and ends in success", async () => {
    const row = { genres: [], styles: [], formats: [], artists: [] };
    db.insert(releases).values({ id: 1, title: "Known", enrichedAt: new Date(1), ...row }).run();
    // Only the data dump's row: the catalogue has it, but no enrichment run has fetched it.
    db.insert(releases).values({ id: 3, title: "From the dump", ...row }).run();
    getInventory.mockResolvedValue(inventory([1, 2, 3]));

    start();
    await settle();

    expect(seller()).toMatchObject({
      username: "Beta",
      lastIndexStatus: "success",
      runUid: "u1",
      inventoryTotal: 3,
      scanCompletedAt: expect.any(Date),
    });
    expect(seller().lastIndexedAt).toBeInstanceOf(Date);
    expect(
      db.select().from(sellerInventory).orderBy(sellerInventory.releaseId).all().map((i) => [i.releaseId, i.status]),
    ).toEqual([
      [1, "active"],
      [2, "active"],
      [3, "active"],
    ]);
    // What the catalogue lacked or only had from the dump was fetched; the enriched one was not.
    expect(getRelease.mock.calls.map(([id]) => id)).toEqual([2, 3]);
    expect(db.select().from(releases).all().map((r) => r.id).sort()).toEqual([1, 2, 3]);
    expect(db.select().from(releases).where(eq(releases.id, 3)).get()!.enrichedAt).toBeInstanceOf(Date);
    expect(getInventory).toHaveBeenCalledWith("Beta", 1, { sort: "artist", order: "asc" }, "token-u1");
    expect(db.select().from(scanPasses).all()).toEqual([expect.objectContaining({ sort: "artist", order: "asc", status: "done" })]);
    // Every job ran on the starting collector's lane.
    expect(new Set(db.select().from(discogsQueueJobs).all().map((job) => job.uid))).toEqual(new Set(["u1"]));
  });

  it("skips the releases the collector faded, and ends in success all the same", async () => {
    db.insert(fades).values({ uid: "u1", kind: "release", id: 2, createdAt: new Date(1) }).run();
    getInventory.mockResolvedValue(inventory([2, 3]));

    start();
    await settle();

    expect(getRelease.mock.calls.map(([id]) => id)).toEqual([3]);
    expect(seller().lastIndexStatus).toBe("success");
  });

  it("walks a second sort order when the first could not reach everything, then stops once covered", async () => {
    getInventory.mockImplementation(async (_username, _page, scan) =>
      scan.sort === "artist" && scan.order === "asc"
        ? inventory([1, 2], 3) // Discogs says 3 listings; the first pass only reaches 2
        : inventory([1, 2, 3], 3),
    );

    start();
    await settle();

    const passes = db.select().from(scanPasses).orderBy(scanPasses.id).all();
    // An inventory under 10,000 items never gets a descending pass, which could add nothing.
    expect(passes.map((p) => [p.sort, p.order])).toEqual([
      ["artist", "asc"],
      ["listed", "asc"],
    ]);
    expect(seller().lastIndexStatus).toBe("success");
    expect(db.select().from(sellerInventory).all()).toHaveLength(3);
  });

  it("marks what a full run no longer sees as sold", async () => {
    getInventory.mockResolvedValue(inventory([1, 2]));
    start();
    await settle();

    getInventory.mockResolvedValue(inventory([1], 1));
    queue.enqueue({ runId: "run-2", type: "seller_profile", payload: { uid: "u1", username: "beta" } });
    await settle();

    expect(
      db.select().from(sellerInventory).orderBy(sellerInventory.releaseId).all().map((i) => [i.releaseId, i.status]),
    ).toEqual([
      [1, "active"],
      [2, "sold"],
    ]);
  });

  it("ends the run in error, without scanning, when the collector has no token", async () => {
    start("someone-else");
    await settle();

    expect(getUserProfile).not.toHaveBeenCalled();
    expect(db.select().from(sellers).all()).toEqual([]);
    expect(db.select().from(discogsQueueJobs).get()).toMatchObject({ status: "failed", errorMessage: "No Discogs token saved" });
  });

  it("ends the run in error when Discogs refuses the token mid-scan", async () => {
    getInventory.mockRejectedValue(new DiscogsAuthError("401"));

    start();
    await settle();

    expect(seller().lastIndexStatus).toBe("error");
  });

  it("ends a pass that Discogs refuses to paginate as capped and carries on, without failing the run", async () => {
    getInventory.mockImplementation(async (_username, page, scan) => {
      if (scan.sort === "artist" && scan.order === "asc" && page === 2) throw new DiscogsPaginationCapError("cap");
      return scan.sort === "artist" && scan.order === "asc"
        ? { pagination: { page, pages: 2, per_page: 100, items: 2, urls: { next: "next" } }, listings: [listing(1)] }
        : inventory([1, 2], 2);
    });

    start();
    await settle();

    expect(db.select().from(scanPasses).where(eq(scanPasses.order, "asc")).get()).toMatchObject({ status: "capped" });
    expect(seller().lastIndexStatus).toBe("success");
  });
});
