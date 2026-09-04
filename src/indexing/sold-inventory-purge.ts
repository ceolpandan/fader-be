import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { sellerInventory } from "../db/schema";
import { logger } from "../util/logger";

export const RETENTION_DAYS = 30;
export const DEFAULT_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function purgeSoldInventory(db: Db, now = new Date()): number {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const deleted = db
    .delete(sellerInventory)
    .where(and(eq(sellerInventory.status, "sold"), lt(sellerInventory.soldAt, cutoff)))
    .returning()
    .all();

  if (deleted.length > 0) {
    logger.info(
      `Purged ${deleted.length} sold seller_inventory row(s) older than ${RETENTION_DAYS} days`,
    );
  }

  return deleted.length;
}

export function startSoldInventoryPurgeLoop(
  db: Db,
  intervalMs: number = DEFAULT_PURGE_INTERVAL_MS,
): () => void {
  purgeSoldInventory(db);
  const timer = setInterval(() => {
    purgeSoldInventory(db);
  }, intervalMs);

  return () => clearInterval(timer);
}
