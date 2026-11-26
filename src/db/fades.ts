import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { fades, masterVersions, releases } from "./schema";

/**
 * SQL condition: the release row is hidden for `uid` (its master or the release itself is faded).
 * Two separate lookups on the whole `fades` key, so each row costs two index probes; one `OR`
 * inside a single subquery would scan all of the user's fades for every release.
 */
export function isFadedFor(uid: string): SQL {
  return sql`(EXISTS (SELECT 1 FROM ${fades} WHERE ${fades.uid} = ${uid} AND ${fades.kind} = 'master' AND ${fades.id} = ${releases.masterId}) OR EXISTS (SELECT 1 FROM ${fades} WHERE ${fades.uid} = ${uid} AND ${fades.kind} = 'release' AND ${fades.id} = ${releases.id}))`;
}

export function isNotFadedFor(uid: string): SQL {
  return sql`NOT ${isFadedFor(uid)}`;
}

/**
 * SQL condition: the release row is hidden for `uid`, driven from the user's fades. Use it where
 * only the faded releases matter (their count): it reads the fades and looks the releases up by
 * master or id instead of testing every release.
 */
export function isFadedViaFades(uid: string): SQL {
  return sql`(${releases.masterId} IN (SELECT ${fades.id} FROM ${fades} WHERE ${fades.uid} = ${uid} AND ${fades.kind} = 'master') OR ${releases.id} IN (SELECT ${fades.id} FROM ${fades} WHERE ${fades.uid} = ${uid} AND ${fades.kind} = 'release'))`;
}

/**
 * SQL condition: `releaseId` is covered by one of `uid`'s fades, either directly or as a stored
 * version of a faded master. Unlike `isFadedFor` this needs no `releases` row, so it also answers
 * for releases we have not enriched yet.
 */
export function isCoveredByFadeFor(uid: string, releaseId: SQLWrapper): SQL {
  return sql`EXISTS (SELECT 1 FROM ${fades} WHERE ${fades.uid} = ${uid} AND ((${fades.kind} = 'release' AND ${fades.id} = ${releaseId}) OR (${fades.kind} = 'master' AND EXISTS (SELECT 1 FROM ${masterVersions} WHERE ${masterVersions.masterId} = ${fades.id} AND ${masterVersions.releaseId} = ${releaseId}))))`;
}
