import { and, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { discogsQueueJobs, sellerListings, sellers, type InventoryPagePayload } from "../db/schema";
import { isInventoryCovered, observedListings } from "./coverage";

/** The run was cut short (Discogs gave up or refused our token): its seller ends in `error`, not `success`. */
export function markRunAborted(db: Db, runId: string): void {
  db.update(sellers)
    .set({ lastIndexStatus: "error" })
    .where(eq(sellers.currentRunId, runId))
    .run();
}

/**
 * Startup safety net: a `running` seller with no pending/processing job for its current run
 * has nothing left to settle it (e.g. a crash mid-start), so it would answer 409 forever.
 * Flip it to `error` so it can be reindexed. Call after the queue has recovered stuck jobs.
 */
export function failOrphanedRuns(db: Db): number {
  const running = db.select().from(sellers).where(eq(sellers.lastIndexStatus, "running")).all();
  let failed = 0;
  for (const seller of running) {
    const unfinished = seller.currentRunId
      ? db
          .select({ id: discogsQueueJobs.id })
          .from(discogsQueueJobs)
          .where(
            and(
              eq(discogsQueueJobs.runId, seller.currentRunId),
              inArray(discogsQueueJobs.status, ["pending", "processing"]),
            ),
          )
          .all()
      : [];
    if (unfinished.length > 0) continue;
    db.update(sellers).set({ lastIndexStatus: "error" }).where(eq(sellers.username, seller.username)).run();
    failed++;
  }
  return failed;
}

/**
 * Called after any job settles (done/failed). If no job for `runId` is left
 * pending/processing, the run is complete: flip the owning seller's status to
 * `success` (a no-op if it's no longer `running` — e.g. a stale/duplicate check).
 */
export function checkRunCompletion(db: Db, runId: string): void {
  const unfinished = db
    .select({ id: discogsQueueJobs.id })
    .from(discogsQueueJobs)
    .where(
      and(eq(discogsQueueJobs.runId, runId), inArray(discogsQueueJobs.status, ["pending", "processing"])),
    )
    .all();

  if (unfinished.length > 0) return;

  const [anyInventoryJob] = db
    .select()
    .from(discogsQueueJobs)
    .where(and(eq(discogsQueueJobs.runId, runId), eq(discogsQueueJobs.type, "inventory_page")))
    .all();

  if (!anyInventoryJob) return;

  const { username, runStartedAt } = anyInventoryJob.payload as InventoryPagePayload;

  purgeUnseenListings(db, username, runId, new Date(runStartedAt));

  db.update(sellers)
    .set({ lastIndexStatus: "success", lastIndexedAt: new Date() })
    .where(and(eq(sellers.username, username), eq(sellers.lastIndexStatus, "running")))
    .run();
}

/**
 * A listing this run did not see is gone from the seller's inventory (sold or withdrawn). Only a
 * run that read every listing can say so: after a partial scan an unseen listing may just be
 * out of reach.
 */
function purgeUnseenListings(db: Db, username: string, runId: string, runStartedAt: Date): void {
  const [seller] = db.select().from(sellers).where(eq(sellers.username, username)).all();
  if (!seller || seller.currentRunId !== runId || seller.inventoryTotal === null) return;
  if (!isInventoryCovered(seller.inventoryTotal, observedListings(db, runId))) return;

  db.delete(sellerListings)
    .where(and(eq(sellerListings.sellerUsername, username), lt(sellerListings.lastSeenAt, runStartedAt)))
    .run();
}
