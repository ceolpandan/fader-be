import { and, eq, lt } from "drizzle-orm";
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

export function createInventoryPageHandler(
  deps: InventoryPageHandlerDeps,
): JobHandler<InventoryPagePayload> {
  return async (payload, context) => {
    const { username, page, runStartedAt } = payload;
    const inventoryPage = await deps.getInventory(username, page);
    const now = new Date();

    if (page === 1) {
      await storeSellerMetadata(deps, username, inventoryPage);
    }

    for (const listing of inventoryPage.listings) {
      const releaseId = listing.release.id;

      deps.db
        .insert(sellerInventory)
        .values({
          sellerUsername: username,
          releaseId,
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

      const [existingRelease] = deps.db
        .select({ id: releases.id })
        .from(releases)
        .where(eq(releases.id, releaseId))
        .all();

      if (!existingRelease) {
        deps.enqueue({
          runId: context.runId,
          type: "release_detail",
          payload: { releaseId },
        });
      }
    }

    const nextUrl = inventoryPage.pagination.urls.next;
    if (nextUrl) {
      deps.enqueue({
        runId: context.runId,
        type: "inventory_page",
        payload: { username, page: page + 1, runStartedAt },
      });
      return;
    }

    const runStart = new Date(runStartedAt);
    deps.db
      .update(sellerInventory)
      .set({ status: "sold", soldAt: now })
      .where(
        and(
          eq(sellerInventory.sellerUsername, username),
          eq(sellerInventory.status, "active"),
          lt(sellerInventory.lastSeenAt, runStart),
        ),
      )
      .run();

    logger.info(`Finished inventory scan for ${username} (run ${context.runId})`);
  };
}
