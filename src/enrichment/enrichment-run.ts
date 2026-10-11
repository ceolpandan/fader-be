import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Request } from "express";
import type { Db } from "../db/client";
import { isNotFadedFor } from "../db/fades";
import { isNotMissing } from "../db/missing";
import {
  discogsQueueJobs,
  enrichmentNotFound,
  enrichmentRuns,
  releases,
  type QueueJobStatus,
  type ReleaseArtistStub,
} from "../db/schema";
import { DiscogsAuthError } from "../discogs-client";
import type { DiscogsQueue } from "../queue/discogs-queue";
import { parseReleaseQuery } from "../routes/release-query";

type RunRow = typeof enrichmentRuns.$inferSelect;

/** What an enrichment run would do for a filter, before anything is queued. */
export interface RunPreview {
  /** Releases the run would fetch from Discogs. */
  count: number;
  /** Releases matching the filter that it leaves alone. */
  skipped: number;
  /** The most releases one run may fetch; null when there is no limit. */
  max: number | null;
}

export type RunScopeError = { error: string };

/**
 * The most releases one run may fetch. `ENRICH_MAX_RELEASES` sets it (0 or less: no limit);
 * without it, production allows 20000 and any other environment has no limit.
 */
export function enrichMaxReleases(): number | null {
  const raw = process.env.ENRICH_MAX_RELEASES;
  if (raw !== undefined && raw !== "") {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }
  return process.env.NODE_ENV === "production" ? 20_000 : null;
}

/** The Explore query string (without `page`) as the object Express would have parsed it into. */
function queryObject(query: string): Request["query"] {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(query)) {
    const earlier = result[key];
    if (earlier === undefined) result[key] = value;
    else result[key] = [...(Array.isArray(earlier) ? earlier : [earlier]), value];
  }
  return result;
}

interface Scope {
  /** The releases the filter shows the collector (a fresh run also takes the missing ones). */
  inScope: SQL[];
  /** Of those, the ones to fetch. */
  toFetch: SQL[];
}

function scopeOf(db: Db, uid: string, query: string, fresh: boolean): Scope | RunScopeError {
  const parsed = parseReleaseQuery({ query: queryObject(query) });
  if ("error" in parsed) return parsed;
  const { filters, styleCombinations } = parsed.query;

  const inScope = [isNotFadedFor(uid), ...filters, ...(styleCombinations ? [styleCombinations] : [])];
  if (!fresh) inScope.push(isNotMissing);

  const toFetch = [...inScope];
  if (!fresh) toFetch.push(sql`${releases.enrichedAt} IS NULL`);

  // A release another run already queued is fetched by that run, whoever started it.
  const queued = queuedReleaseIds(db);
  if (queued.length > 0) toFetch.push(sql`${releases.id} NOT IN (SELECT value FROM json_each(${JSON.stringify(queued)}))`);
  return { inScope, toFetch };
}

function queuedReleaseIds(db: Db): number[] {
  return db
    .select({ payload: discogsQueueJobs.payload })
    .from(discogsQueueJobs)
    .where(
      and(
        eq(discogsQueueJobs.type, "release_detail"),
        inArray(discogsQueueJobs.status, ["pending", "processing"]),
      ),
    )
    .all()
    .map((job) => (job.payload as { releaseId: number }).releaseId);
}

function countWhere(db: Db, where: SQL[]): number {
  return db
    .select({ n: count() })
    .from(releases)
    .where(and(...where))
    .get()!.n;
}

export function previewRun(db: Db, uid: string, query: string, fresh: boolean): RunPreview | RunScopeError {
  const scope = scopeOf(db, uid, query, fresh);
  if ("error" in scope) return scope;
  const toFetch = countWhere(db, scope.toFetch);
  return { count: toFetch, skipped: countWhere(db, scope.inScope) - toFetch, max: enrichMaxReleases() };
}

export type StartResult =
  | { run: RunRow }
  | RunScopeError
  | { conflict: "run_active" }
  | { tooMany: RunPreview };

/** Queues one `release_detail` job per release the filter shows that still needs fetching. */
export function startRun(db: Db, queue: DiscogsQueue, uid: string, query: string, fresh: boolean): StartResult {
  if (activeRun(db, uid)) return { conflict: "run_active" };
  const scope = scopeOf(db, uid, query, fresh);
  if ("error" in scope) return scope;

  const toFetch = countWhere(db, scope.toFetch);
  const max = enrichMaxReleases();
  if (max !== null && toFetch > max) {
    return { tooMany: { count: toFetch, skipped: countWhere(db, scope.inScope) - toFetch, max } };
  }

  const ids = db
    .select({ id: releases.id })
    .from(releases)
    .where(and(...scope.toFetch))
    .orderBy(releases.id)
    .all()
    .map((row) => row.id);

  const id = randomUUID();
  const startedAt = new Date();
  db.transaction(() => {
    forgetLastRun(db, uid);
    db.insert(enrichmentRuns)
      .values({
        id,
        uid,
        query,
        fresh,
        status: ids.length > 0 ? "running" : "done",
        total: ids.length,
        skipped: countWhere(db, scope.inScope) - ids.length,
        startedAt,
        finishedAt: ids.length > 0 ? null : startedAt,
      })
      .run();
    for (const releaseId of ids) {
      queue.enqueue({ runId: id, type: "release_detail", payload: { uid, releaseId } });
    }
  });
  return { run: db.select().from(enrichmentRuns).where(eq(enrichmentRuns.id, id)).get()! };
}

/** Only the latest run of a collector is kept: its row, its not-found list and its finished jobs. */
function forgetLastRun(db: Db, uid: string): void {
  const old = db.select({ id: enrichmentRuns.id }).from(enrichmentRuns).where(eq(enrichmentRuns.uid, uid)).all();
  const ids = old.map((row) => row.id);
  if (ids.length === 0) return;
  db.delete(enrichmentNotFound).where(inArray(enrichmentNotFound.runId, ids)).run();
  db.delete(discogsQueueJobs).where(inArray(discogsQueueJobs.runId, ids)).run();
  db.delete(enrichmentRuns).where(inArray(enrichmentRuns.id, ids)).run();
}

export function activeRun(db: Db, uid: string): RunRow | undefined {
  return db
    .select()
    .from(enrichmentRuns)
    .where(and(eq(enrichmentRuns.uid, uid), eq(enrichmentRuns.status, "running")))
    .get();
}

/** The collector's active run, or else their last one. */
export function currentRun(db: Db, uid: string): RunRow | undefined {
  return activeRun(db, uid) ?? db.select().from(enrichmentRuns).where(eq(enrichmentRuns.uid, uid)).get();
}

/** Stops the active run: its queued jobs are dropped, the one being fetched still finishes. */
export function cancelActiveRun(db: Db, queue: DiscogsQueue, uid: string): RunRow | undefined {
  const run = activeRun(db, uid);
  if (!run) return undefined;
  const dropped = queue.cancelRun(run.id);
  db.update(enrichmentRuns)
    .set({ status: "cancelled", total: run.total - dropped, finishedAt: new Date() })
    .where(eq(enrichmentRuns.id, run.id))
    .run();
  return db.select().from(enrichmentRuns).where(eq(enrichmentRuns.id, run.id)).get();
}

export interface RunProgress {
  enriched: number;
  notFound: number;
  failed: number;
  remaining: number;
}

export function runProgress(db: Db, runId: string): RunProgress {
  const byStatus = new Map<QueueJobStatus, number>(
    db
      .select({ status: discogsQueueJobs.status, n: count() })
      .from(discogsQueueJobs)
      .where(eq(discogsQueueJobs.runId, runId))
      .groupBy(discogsQueueJobs.status)
      .all()
      .map((row) => [row.status, row.n]),
  );
  const notFound = db.select({ n: count() }).from(enrichmentNotFound).where(eq(enrichmentNotFound.runId, runId)).get()!.n;
  return {
    enriched: byStatus.get("done") ?? 0,
    notFound,
    failed: (byStatus.get("failed") ?? 0) - notFound,
    remaining: (byStatus.get("pending") ?? 0) + (byStatus.get("processing") ?? 0),
  };
}

export function notFoundReleases(
  db: Db,
  runId: string,
): { releaseId: number; title: string; artists: ReleaseArtistStub[] }[] {
  return db
    .select({ releaseId: releases.id, title: releases.title, artists: releases.artists })
    .from(enrichmentNotFound)
    .innerJoin(releases, eq(releases.id, enrichmentNotFound.releaseId))
    .where(eq(enrichmentNotFound.runId, runId))
    .orderBy(releases.id)
    .all();
}

/** Queue listener: a run whose last job has settled is done. */
export function finishRunWhenSettled(db: Db, job: { type: string; runId: string }): void {
  if (job.type !== "release_detail") return;
  if (runProgress(db, job.runId).remaining > 0) return;
  db.update(enrichmentRuns)
    .set({ status: "done", finishedAt: new Date() })
    .where(and(eq(enrichmentRuns.id, job.runId), eq(enrichmentRuns.status, "running")))
    .run();
}

/** Queue listener: Discogs refused the token or stayed down, so the run ended early. */
export function failRun(db: Db, runId: string, cause: unknown): void {
  const errorMessage =
    cause instanceof DiscogsAuthError
      ? "Discogs rejected your token"
      : `Discogs kept failing: ${cause instanceof Error ? cause.message : String(cause)}`;
  db.update(enrichmentRuns)
    .set({ status: "failed", errorMessage, finishedAt: new Date() })
    .where(and(eq(enrichmentRuns.id, runId), inArray(enrichmentRuns.status, ["running", "done"])))
    .run();
}
