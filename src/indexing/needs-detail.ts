import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { releases } from "../db/schema";

/**
 * A seller's release still needs its Discogs details: the catalogue has no row for it, or the row
 * came from the data dump and no enrichment run has fetched it yet. A release Discogs reported
 * gone (`missing_at`) is left alone.
 */
export function needsDetail(releaseId: SQLWrapper): SQL {
  return sql`(${releaseId} NOT IN (SELECT ${releases.id} FROM ${releases})
    OR ${releaseId} IN (SELECT ${releases.id} FROM ${releases} WHERE ${releases.enrichedAt} IS NULL AND ${releases.missingAt} IS NULL))`;
}
