import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { releases, scanPasses, sellerInventory, sellers } from "../db/schema";
import type { InventoryPagePayload, ScanOrder, ScanPassStatus } from "../db/schema";
import { DiscogsPaginationCapError } from "../discogs-client";
import type { EnqueueInput, JobHandler } from "../queue/discogs-queue";
import type { DiscogsInventoryPage, DiscogsUserProfile } from "../types/discogs-api";
import { logger } from "../util/logger";

export interface InventoryPageHandlerDeps {
  db: Db;
  enqueue: (job: EnqueueInput) => number;
  getInventory: (
    username: string,
    page: number,
    scan: { sort: string; order: string },
  ) => Promise<DiscogsInventoryPage>;
  getUserProfile?: (username: string) => Promise<DiscogsUserProfile>;
}

/** Best effort: a missing or failing profile must never fail the indexing run. */
async function storeSellerMetadata(
  deps: InventoryPageHandlerDeps,
  username: string,
  inventoryPage: DiscogsInventoryPage,
): Promise<void> {
  const shipsFromCountry = inventoryPage.listings[0]?.ships_from ?? null;
  let sellerRating: number | null = null;
  let sellerNumRatings: number | null = null;

  if (deps.getUserProfile) {
    try {
      const profile = await deps.getUserProfile(username);
      sellerRating = profile.seller_rating ?? null;
      sellerNumRatings = profile.seller_num_ratings ?? null;
    } catch (error) {
      logger.warn(`Could not fetch Discogs profile for ${username}: ${String(error)}`);
    }
  }

  deps.db
    .update(sellers)
    .set({ sellerRating, sellerNumRatings, shipsFromCountry })
    .where(eq(sellers.username, username))
    .run();
}

/** Discogs only serves the first 100 pages (of 100 listings) of another seller's inventory. */
export const MAX_SCAN_PAGES = 100;
const PAGE_SIZE = 100;
/** Inventory items one sorted pass can reach. */
export const MAX_REACHABLE_ITEMS = MAX_SCAN_PAGES * PAGE_SIZE;

/**
 * Pages a pass will fetch. The ascending pass takes everything Discogs lets it; the descending
 * pass only reaches for what the ascending one could not (the far end of the sort).
 */
export function passPagesPlanned(order: ScanOrder, items: number, pages: number): number {
  if (order === "asc") return Math.min(pages, MAX_SCAN_PAGES);
  return Math.min(MAX_SCAN_PAGES, Math.ceil(Math.max(0, items - MAX_REACHABLE_ITEMS) / PAGE_SIZE));
}

/** Pages the whole scan will fetch: the ascending pass, plus a descending one past the cap. */
export function scanPagesPlanned(items: number, pages: number): number {
  const asc = passPagesPlanned("asc", items, pages);
  return items > MAX_REACHABLE_ITEMS ? asc + passPagesPlanned("desc", items, pages) : asc;
}

/**
 * The scan is over: queue a `release_detail` job for every release this run saw that we don't
 * have yet. Doing this only now means the total to enrich is fixed before enrichment begins.
 */
function finishScan(
  deps: InventoryPageHandlerDeps,
  username: string,
  runId: string,
  runStartedAt: Date,
): void {
  const unknown = deps.db
    .select({ releaseId: sellerInventory.releaseId })
    .from(sellerInventory)
    .where(
      and(
        eq(sellerInventory.sellerUsername, username),
        gte(sellerInventory.lastSeenAt, runStartedAt),
        sql`${sellerInventory.releaseId} NOT IN (SELECT ${releases.id} FROM ${releases})`,
      ),
    )
    .all();

  for (const { releaseId } of unknown) {
    deps.enqueue({ runId, type: "release_detail", payload: { releaseId } });
  }

  deps.db
    .update(sellers)
    .set({ scanCompletedAt: new Date() })
    .where(eq(sellers.username, username))
    .run();

  logger.info(
    `Finished inventory scan for ${username} (run ${runId}): ${unknown.length} release(s) to enrich`,
  );
}

export function createInventoryPageHandler(
  deps: InventoryPageHandlerDeps,
): JobHandler<InventoryPagePayload> {
  return async (payload, context) => {
    const { username, page, runStartedAt } = payload;
    const sort = payload.sort ?? "artist";
    const order = payload.order ?? "asc";
    const passKey = and(
      eq(scanPasses.runId, context.runId),
      eq(scanPasses.sort, sort),
      eq(scanPasses.order, order),
    );

    /** Close this pass, then start the descending one if the ascending one left items out of reach. */
    const endPass = (status: ScanPassStatus): void => {
      deps.db.update(scanPasses).set({ status, endedAt: new Date() }).where(passKey).run();

      const [seller] = deps.db.select().from(sellers).where(eq(sellers.username, username)).all();
      if (order === "asc" && (seller?.inventoryTotal ?? 0) > MAX_REACHABLE_ITEMS) {
        deps.enqueue({
          runId: context.runId,
          type: "inventory_page",
          payload: { username, page: 1, runStartedAt, sort, order: "desc" },
        });
        return;
      }
      finishScan(deps, username, context.runId, new Date(runStartedAt));
    };

    let inventoryPage: DiscogsInventoryPage;
    try {
      inventoryPage = await deps.getInventory(username, page, { sort, order });
    } catch (error) {
      if (!(error instanceof DiscogsPaginationCapError)) throw error;
      logger.warn(`Discogs stopped paginating ${username} (${sort} ${order}) at page ${page}`);
      endPass("capped");
      return;
    }
    const now = new Date();
    const runStart = new Date(runStartedAt);
    const { items, pages } = inventoryPage.pagination;

    if (page === 1) {
      if (order === "asc") {
        await storeSellerMetadata(deps, username, inventoryPage);
        deps.db
          .update(sellers)
          .set({ inventoryTotal: items, scanPagesTotal: scanPagesPlanned(items, pages) })
          .where(eq(sellers.username, username))
          .run();
      }
      deps.db
        .insert(scanPasses)
        .values({
          runId: context.runId,
          sellerUsername: username,
          sort,
          order,
          pagesPlanned: passPagesPlanned(order, items, pages),
          status: "running",
          startedAt: now,
        })
        .onConflictDoNothing()
        .run();
    }

    let itemsNew = 0;
    for (const listing of inventoryPage.listings) {
      const [existing] = deps.db
        .select({ lastSeenAt: sellerInventory.lastSeenAt })
        .from(sellerInventory)
        .where(
          and(
            eq(sellerInventory.sellerUsername, username),
            eq(sellerInventory.releaseId, listing.release.id),
          ),
        )
        .all();
      if (!existing || existing.lastSeenAt < runStart) itemsNew += 1;

      deps.db
        .insert(sellerInventory)
        .values({
          sellerUsername: username,
          releaseId: listing.release.id,
          status: "active",
          firstSeenAt: now,
          lastSeenAt: now,
          soldAt: null,
        })
        .onConflictDoUpdate({
          target: [sellerInventory.sellerUsername, sellerInventory.releaseId],
          set: { status: "active", lastSeenAt: now, soldAt: null },
        })
        .run();
    }

    deps.db
      .update(scanPasses)
      .set({
        pagesFetched: sql`${scanPasses.pagesFetched} + 1`,
        itemsSeen: sql`${scanPasses.itemsSeen} + ${inventoryPage.listings.length}`,
        itemsNew: sql`${scanPasses.itemsNew} + ${itemsNew}`,
      })
      .where(passKey)
      .run();
    deps.db
      .update(sellers)
      .set({ scanPagesFetched: sql`${sellers.scanPagesFetched} + 1` })
      .where(eq(sellers.username, username))
      .run();

    const [pass] = deps.db.select().from(scanPasses).where(passKey).all();
    const planned = pass?.pagesPlanned ?? passPagesPlanned(order, items, pages);

    if (inventoryPage.pagination.urls.next && page < planned) {
      deps.enqueue({
        runId: context.runId,
        type: "inventory_page",
        payload: { username, page: page + 1, runStartedAt, sort, order },
      });
      return;
    }

    endPass("done");
  };
}
