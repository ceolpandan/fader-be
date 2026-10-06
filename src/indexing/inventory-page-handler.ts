import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { releases, sellerInventory, sellers } from "../db/schema";
import type { InventoryPagePayload } from "../db/schema";
import type { EnqueueInput, JobHandler } from "../queue/discogs-queue";
import type { DiscogsInventoryPage, DiscogsUserProfile } from "../types/discogs-api";
import { logger } from "../util/logger";

export interface InventoryPageHandlerDeps {
  db: Db;
  enqueue: (job: EnqueueInput) => number;
  getInventory: (username: string, page: number) => Promise<DiscogsInventoryPage>;
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
    const inventoryPage = await deps.getInventory(username, page);
    const now = new Date();

    if (page === 1) {
      await storeSellerMetadata(deps, username, inventoryPage);
      deps.db
        .update(sellers)
        .set({
          inventoryTotal: inventoryPage.pagination.items,
          scanPagesTotal: Math.min(inventoryPage.pagination.pages, MAX_SCAN_PAGES),
        })
        .where(eq(sellers.username, username))
        .run();
    }

    for (const listing of inventoryPage.listings) {
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
      .update(sellers)
      .set({ scanPagesFetched: page })
      .where(eq(sellers.username, username))
      .run();

    if (inventoryPage.pagination.urls.next && page < MAX_SCAN_PAGES) {
      deps.enqueue({
        runId: context.runId,
        type: "inventory_page",
        payload: { username, page: page + 1, runStartedAt },
      });
      return;
    }

    finishScan(deps, username, context.runId, new Date(runStartedAt));
  };
}
