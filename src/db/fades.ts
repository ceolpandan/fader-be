import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { fades, masterVersions, releases } from "./schema";

/** SQL condition: the release row is hidden for `uid` (its master or the release itself is faded). */
export function isFadedFor(uid: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${fades} WHERE ${fades.uid} = ${uid} AND ((${fades.kind} = 'master' AND ${fades.id} = ${releases.masterId}) OR (${fades.kind} = 'release' AND ${fades.id} = ${releases.id})))`;
}

export function isNotFadedFor(uid: string): SQL {
  return sql`NOT ${isFadedFor(uid)}`;
}

/**
 * SQL condition: `releaseId` is covered by one of `uid`'s fades, either directly or as a stored
 * version of a faded master. Unlike `isFadedFor` this needs no `releases` row, so it also answers
 * for releases we have not enriched yet.
 */
export function isCoveredByFadeFor(uid: string, releaseId: SQLWrapper): SQL {
  return sql`EXISTS (SELECT 1 FROM ${fades} WHERE ${fades.uid} = ${uid} AND ((${fades.kind} = 'release' AND ${fades.id} = ${releaseId}) OR (${fades.kind} = 'master' AND EXISTS (SELECT 1 FROM ${masterVersions} WHERE ${masterVersions.masterId} = ${fades.id} AND ${masterVersions.releaseId} = ${releaseId}))))`;
}
