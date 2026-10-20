import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { wantlistFolderItems, wantlistItems } from "./schema";

/** Drops the collector's folder membership for releases no longer on their wantlist. Call it in the transaction that changes the wantlist. */
export function pruneFolderMembership(db: Pick<Db, "delete">, uid: string): void {
  db.delete(wantlistFolderItems)
    .where(
      and(
        eq(wantlistFolderItems.uid, uid),
        sql`NOT EXISTS (SELECT 1 FROM ${wantlistItems} WHERE ${wantlistItems.uid} = ${uid} AND ${wantlistItems.releaseId} = ${wantlistFolderItems.releaseId})`,
      ),
    )
    .run();
}
