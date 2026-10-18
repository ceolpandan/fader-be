import { and, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { isFadedViaFades, isNotFadedFor } from "../db/fades";
import { isNotMissing } from "../db/missing";
import { releases } from "../db/schema";
import type { ReleaseListPageDto } from "../dto/release-list.dto";
import { previewRun, type RunPreview, type RunScopeError } from "../enrichment/enrichment-run";
import { parseReleaseQuery } from "../routes/release-query";
import { rarityHaveMaxOf } from "../routes/settings";

/**
 * The slow read queries: full scans of the releases table (LIKE '%word%', json_each, counts).
 * better-sqlite3 is synchronous, so each runs on a worker thread's own read-only connection
 * (see read-runner.ts) instead of blocking the event loop that serves requests and the queue.
 * Arguments and results cross the thread boundary, so they must be plain structured-cloneable data.
 */

export type ListReleasesResult = { error: string } | { page: ReleaseListPageDto };

function listReleases(db: Db, input: { query: Record<string, unknown>; uid: string }): ListReleasesResult {
  const { uid } = input;
  const parsed = parseReleaseQuery({ query: input.query as never }, rarityHaveMaxOf(db, uid), uid);
  if ("error" in parsed) return { error: parsed.error };
  const { page, pageSize, styleCombinations, orderBy } = parsed.query;
  const filters = styleCombinations ? [...parsed.query.filters, styleCombinations] : parsed.query.filters;

  const countReleases = (...where: SQL[]): number =>
    db
      .select({ count: sql<number>`count(*)` })
      .from(releases)
      .where(and(...where))
      .all()[0]!.count;

  const total = countReleases(isNotMissing, isNotFadedFor(uid), ...filters);
  const items = db
    .select({
      releaseId: releases.id,
      title: releases.title,
      year: releases.year,
      country: releases.country,
      genres: releases.genres,
      styles: releases.styles,
      formats: releases.formats,
      ratingAverage: releases.ratingAverage,
      ratingCount: releases.ratingCount,
      thumb: releases.thumb,
      artists: releases.artists,
      labels: releases.labels,
      versionCount: releases.versionCount,
    })
    .from(releases)
    .where(and(isNotMissing, isNotFadedFor(uid), ...filters))
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  return { page: { items, page, pageSize, total, fadedCount: countReleases(isNotMissing, isFadedViaFades(uid)) } };
}

function previewEnrichment(
  db: Db,
  input: { uid: string; query: string; fresh: boolean },
): RunPreview | RunScopeError {
  return previewRun(db, input.uid, input.query, input.fresh);
}

export const READ_OPS = { listReleases, previewEnrichment };

export type ReadOps = typeof READ_OPS;
export type ReadOpName = keyof ReadOps;
export type ReadOpInput<K extends ReadOpName> = Parameters<ReadOps[K]>[1];
export type ReadOpResult<K extends ReadOpName> = ReturnType<ReadOps[K]>;
