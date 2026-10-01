import { sql, type SQL } from "drizzle-orm";
import { fades, releases } from "./schema";

/** SQL condition: the release row is hidden for `uid` (its master or the release itself is faded). */
export function isFadedFor(uid: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${fades} WHERE ${fades.uid} = ${uid} AND ((${fades.kind} = 'master' AND ${fades.id} = ${releases.masterId}) OR (${fades.kind} = 'release' AND ${fades.id} = ${releases.id})))`;
}

export function isNotFadedFor(uid: string): SQL {
  return sql`NOT ${isFadedFor(uid)}`;
}
