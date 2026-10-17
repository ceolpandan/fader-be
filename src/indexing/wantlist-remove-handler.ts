import { and, count, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  collectionItems,
  discogsProfiles,
  discogsTokens,
  hiddenReleases,
  wantlistItems,
  type WantlistRemovePayload,
} from "../db/schema";
import { NonRetryableError, type JobHandler } from "../queue/discogs-queue";

export interface WantlistRemoveHandlerDeps {
  db: Db;
  /** The collector's Discogs token, or null when they have none (the job then fails). */
  getToken: (uid: string) => string | null;
  deleteWantlistItem: (username: string, releaseId: number, token: string) => Promise<void>;
}

/**
 * Takes a release off the collector's Discogs wantlist and then off the mirror of it, so the next
 * sync does not find it there. Its hidden row goes with it unless the release is also in their
 * collection. Nothing local changes when Discogs refuses.
 */
export function createWantlistRemoveHandler(deps: WantlistRemoveHandlerDeps): JobHandler<WantlistRemovePayload> {
  const { db } = deps;

  return async ({ uid, releaseId }) => {
    const token = deps.getToken(uid);
    const username = db
      .select({ username: discogsTokens.username })
      .from(discogsTokens)
      .where(eq(discogsTokens.uid, uid))
      .get()?.username;
    if (!token || !username) throw new NonRetryableError("No Discogs token saved");

    await deps.deleteWantlistItem(username, releaseId, token);

    db.transaction((tx) => {
      tx.delete(wantlistItems).where(and(eq(wantlistItems.uid, uid), eq(wantlistItems.releaseId, releaseId))).run();
      const owned = tx
        .select({ releaseId: collectionItems.releaseId })
        .from(collectionItems)
        .where(and(eq(collectionItems.uid, uid), eq(collectionItems.releaseId, releaseId)))
        .get();
      if (!owned) {
        tx.delete(hiddenReleases).where(and(eq(hiddenReleases.uid, uid), eq(hiddenReleases.releaseId, releaseId))).run();
      }
      const remaining = tx.select({ n: count() }).from(wantlistItems).where(eq(wantlistItems.uid, uid)).get()!.n;
      tx.update(discogsProfiles).set({ wantlistCount: remaining }).where(eq(discogsProfiles.uid, uid)).run();
    });
  };
}
