import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { scanListings, sellerInventory } from "../db/schema";

/** Distinct inventory items of the seller that a scan since `since` has seen. */
export function observedItems(db: Db, username: string, since: Date): number {
  return db
    .select({ count: sql<number>`count(*)` })
    .from(sellerInventory)
    .where(and(eq(sellerInventory.sellerUsername, username), gte(sellerInventory.lastSeenAt, since)))
    .all()[0]!.count;
}

/** Distinct listings (copies of a release count separately) that the run has read. */
export function observedListings(db: Db, runId: string): number {
  return db
    .select({ count: sql<number>`count(distinct ${scanListings.listingId})` })
    .from(scanListings)
    .where(eq(scanListings.runId, runId))
    .all()[0]!.count;
}

/**
 * Whether a scan has reached the whole inventory: it has read as many distinct listings as Discogs
 * reports. Listings, not releases, because a seller with several copies of a release never shows
 * that many distinct releases.
 */
export function isInventoryCovered(total: number, listingsSeen: number): boolean {
  return listingsSeen >= total;
}
