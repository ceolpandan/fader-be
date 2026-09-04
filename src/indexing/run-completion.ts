import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { discogsQueueJobs, sellers, type InventoryPagePayload } from "../db/schema";

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

  const { username } = anyInventoryJob.payload as InventoryPagePayload;

  db.update(sellers)
    .set({ lastIndexStatus: "success", lastIndexedAt: new Date() })
    .where(and(eq(sellers.username, username), eq(sellers.lastIndexStatus, "running")))
    .run();
}
