import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { isNotMissing } from "../db/missing";
import { collectionItems, discogsQueueJobs, releaseRaw, releases, wantlistItems } from "../db/schema";
import { RAW_BACKFILL_PRIORITY, type DiscogsQueue } from "../queue/discogs-queue";

export interface RawBackfillOptions {
  /** Queue at most this many releases (the collector's own first). */
  limit?: number;
  /** Count only; queue nothing. */
  dryRun?: boolean;
}

export interface RawBackfillResult {
  /** Enriched releases with no `release_raw` row and no job already queued. */
  candidates: number;
  /** Of those, the ones in the collector's wantlist or collection. */
  inCollectorLists: number;
  /** Jobs queued by this call (0 for a dry run). */
  queued: number;
}

/** Not a row of `enrichment_runs`: the jobs belong to no run, so a collector's own runs are not blocked. */
export const rawBackfillRunId = (uid: string): string => `raw-backfill:${uid}`;

/**
 * Queues a `release_detail` job for every enriched release that has no `release_raw` row, the
 * collector's wantlist and collection first (fader-ui#151). The missing row is the marker, so a
 * rerun after a crash, a restart or an aborted lane queues only what is still missing, and a
 * release with a pending or processing job is left alone. Releases marked missing are skipped:
 * Discogs would answer 404 again. The jobs run at RAW_BACKFILL_PRIORITY once the queue starts.
 */
export function queueRawBackfill(
  db: Db,
  queue: DiscogsQueue,
  uid: string,
  { limit, dryRun = false }: RawBackfillOptions = {},
): RawBackfillResult {
  const needsRaw = and(
    sql`${releases.enrichedAt} IS NOT NULL`,
    isNotMissing,
    sql`NOT EXISTS (SELECT 1 FROM ${releaseRaw} WHERE ${releaseRaw.releaseId} = ${releases.id})`,
  );
  const queued = new Set(
    db
      .select({ releaseId: sql<number>`json_extract(${discogsQueueJobs.payload}, '$.releaseId')` })
      .from(discogsQueueJobs)
      .where(
        and(eq(discogsQueueJobs.type, "release_detail"), inArray(discogsQueueJobs.status, ["pending", "processing"])),
      )
      .all()
      .map((row) => row.releaseId),
  );
  const inLists = or(
    inArray(
      releases.id,
      db.select({ id: wantlistItems.releaseId }).from(wantlistItems).where(eq(wantlistItems.uid, uid)),
    ),
    inArray(
      releases.id,
      db.select({ id: collectionItems.releaseId }).from(collectionItems).where(eq(collectionItems.uid, uid)),
    ),
  );
  const idsWhere = (where: ReturnType<typeof and>) =>
    db
      .select({ id: releases.id })
      .from(releases)
      .where(where)
      .orderBy(releases.id)
      .all()
      .map((row) => row.id)
      .filter((id) => !queued.has(id));

  const ownIds = idsWhere(and(needsRaw, inLists));
  const own = new Set(ownIds);
  const otherIds = idsWhere(needsRaw).filter((id) => !own.has(id));
  const candidates = ownIds.length + otherIds.length;
  const result = { candidates, inCollectorLists: ownIds.length, queued: 0 };
  if (dryRun) return result;

  const toQueue = [...ownIds, ...otherIds].slice(0, limit ?? candidates);
  const runId = rawBackfillRunId(uid);
  db.transaction(() => {
    for (const releaseId of toQueue) {
      queue.enqueue({ runId, type: "release_detail", payload: { uid, releaseId }, priority: RAW_BACKFILL_PRIORITY });
    }
  });
  return { ...result, queued: toQueue.length };
}
