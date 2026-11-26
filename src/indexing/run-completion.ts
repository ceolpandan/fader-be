import { and, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { discogsQueueJobs, sellerInventory, sellers } from "../db/schema";
import { isInventoryCovered, observedListings } from "./coverage";

/** The run was cut short (Discogs gave up or refused our token): its seller ends in `error`, not `success`. */
export function markRunAborted(db: Db, runId: string): void {
  db.update(sellers)
    .set({ lastIndexStatus: "error" })
    .where(and(eq(sellers.currentRunId, runId), eq(sellers.lastIndexStatus, "running")))
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
    if (seller.currentRunId && hasUnfinishedJobs(db, seller.currentRunId)) continue;
    db.update(sellers).set({ lastIndexStatus: "error" }).where(eq(sellers.username, seller.username)).run();
    failed++;
  }
  return failed;
}

function hasUnfinishedJobs(db: Db, runId: string): boolean {
  return (
    db
      .select({ id: discogsQueueJobs.id })
      .from(discogsQueueJobs)
      .where(and(eq(discogsQueueJobs.runId, runId), inArray(discogsQueueJobs.status, ["pending", "processing"])))
      .limit(1)
      .all().length > 0
  );
}

/**
 * Called after any job settles (done/failed). If the job's run is a seller's current run and no job
 * of it is left pending/processing, the run is over. It is a `success` when the scan finished; when
 * a scan page failed for good (no token saved, say) nothing queued the rest, so it is an `error`.
 * A no-op for any other run, and for a seller that is no longer `running`.
 */
export function checkRunCompletion(db: Db, runId: string): void {
  const [seller] = db
    .select()
    .from(sellers)
    .where(and(eq(sellers.currentRunId, runId), eq(sellers.lastIndexStatus, "running")))
    .all();
  if (!seller) return;
  if (hasUnfinishedJobs(db, runId)) return;

  if (seller.scanCompletedAt === null) {
    db.update(sellers).set({ lastIndexStatus: "error" }).where(eq(sellers.username, seller.username)).run();
    return;
  }

  markGoneListingsSold(db, seller.username, runId, seller.inventoryTotal, seller.scanCompletedAt);
  db.update(sellers)
    .set({ lastIndexStatus: "success", lastIndexedAt: new Date() })
    .where(eq(sellers.username, seller.username))
    .run();
}

/**
 * An item this run did not see is gone from the seller's inventory (sold or withdrawn). Only a run
 * that read every listing can say so: after a partial scan an unseen item may just be out of reach.
 */
function markGoneListingsSold(
  db: Db,
  username: string,
  runId: string,
  inventoryTotal: number | null,
  scanCompletedAt: Date,
): void {
  if (inventoryTotal === null) return;
  if (!isInventoryCovered(inventoryTotal, observedListings(db, runId))) return;

  const runStartedAt = runStart(db, runId);
  if (!runStartedAt) return;
  db.update(sellerInventory)
    .set({ status: "sold", soldAt: scanCompletedAt })
    .where(
      and(
        eq(sellerInventory.sellerUsername, username),
        eq(sellerInventory.status, "active"),
        lt(sellerInventory.lastSeenAt, runStartedAt),
      ),
    )
    .run();
}

/** When the run's first pass began: anything last seen before it was not on the shelf during the run. */
function runStart(db: Db, runId: string): Date | null {
  const [first] = db
    .select({ payload: discogsQueueJobs.payload })
    .from(discogsQueueJobs)
    .where(and(eq(discogsQueueJobs.runId, runId), eq(discogsQueueJobs.type, "inventory_page")))
    .limit(1)
    .all();
  const startedAt = (first?.payload as { runStartedAt?: string } | undefined)?.runStartedAt;
  return startedAt ? new Date(startedAt) : null;
}
