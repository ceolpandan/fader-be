import type { Db } from "../db/client";
import { digitalMatches } from "../db/schema";
import type { DigitalMatchResult, DigitalStoreId } from "./types";

/** Stores what a check found, replacing the release's earlier match for the store; returns the row. */
export function saveDigitalMatch(
  db: Db,
  releaseId: number,
  store: DigitalStoreId,
  result: DigitalMatchResult,
): typeof digitalMatches.$inferSelect {
  const row = {
    releaseId,
    store,
    status: result.status,
    url: result.url,
    tracks: result.tracks,
    trackCount: result.trackCount,
    checkedAt: new Date(),
  };
  db.insert(digitalMatches)
    .values(row)
    .onConflictDoUpdate({
      target: [digitalMatches.releaseId, digitalMatches.store],
      set: {
        status: row.status,
        url: row.url,
        tracks: row.tracks,
        trackCount: row.trackCount,
        checkedAt: row.checkedAt,
      },
    })
    .run();
  return row;
}
