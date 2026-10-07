import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { sellerInventory } from "../db/schema";

/** Distinct inventory items of the seller that a scan since `since` has seen. */
export function observedItems(db: Db, username: string, since: Date): number {
  return db
    .select({ count: sql<number>`count(*)` })
    .from(sellerInventory)
    .where(and(eq(sellerInventory.sellerUsername, username), gte(sellerInventory.lastSeenAt, since)))
    .all()[0]!.count;
}

/**
 * Whether a scan has reached the whole inventory. Discogs' `pagination.items` counts listings, so
 * a seller with several copies of a release never shows that many distinct items; a single pass
 * that returned every listing is also proof of full coverage.
 */
export function isInventoryCovered(
  total: number,
  observed: number,
  passes: { itemsSeen: number }[],
): boolean {
  return observed >= total || passes.some((pass) => pass.itemsSeen >= total);
}
