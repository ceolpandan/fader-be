import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { sellers, type SellerProfilePayload } from "../db/schema";
import { DiscogsNotFoundError } from "../discogs-client";
import { NonRetryableError, SCAN_PRIORITY, type EnqueueInput, type JobHandler } from "../queue/discogs-queue";
import type { DiscogsUserProfile } from "../types/discogs-api";

export interface SellerProfileHandlerDeps {
  db: Db;
  enqueue: (job: EnqueueInput) => number;
  /** The collector's Discogs token, or null when they have none (the job then fails). */
  getToken: (uid: string) => string | null;
  getUserProfile: (username: string, token: string) => Promise<DiscogsUserProfile>;
}

/**
 * Confirms the Discogs user exists before we keep anything about them. Only then is the Seller
 * created, under the casing Discogs reports, and its run started with the job's own `runId`
 * so the caller can find what was started. A Seller that is already running is left alone.
 */
export function createSellerProfileHandler(
  deps: SellerProfileHandlerDeps,
): JobHandler<SellerProfilePayload> {
  return async ({ uid, username: typed }, context) => {
    const token = deps.getToken(uid);
    if (!token) throw new NonRetryableError("No Discogs token saved");

    let profile: DiscogsUserProfile;
    try {
      profile = await deps.getUserProfile(typed, token);
    } catch (err) {
      if (err instanceof DiscogsNotFoundError) throw new NonRetryableError(err.message);
      throw err;
    }

    const username = profile.username;
    const runStartedAt = new Date().toISOString();

    deps.db.transaction(() => {
      const [existing] = deps.db.select().from(sellers).where(eq(sellers.username, username)).all();
      if (existing?.lastIndexStatus === "running") return;

      deps.db
        .insert(sellers)
        .values({ username, lastIndexStatus: "running", currentRunId: context.runId, runUid: uid })
        .onConflictDoUpdate({
          target: sellers.username,
          set: {
            lastIndexStatus: "running",
            currentRunId: context.runId,
            runUid: uid,
            inventoryTotal: null,
            scanPagesTotal: null,
            scanPagesFetched: 0,
            scanCompletedAt: null,
          },
        })
        .run();

      deps.enqueue({
        runId: context.runId,
        type: "inventory_page",
        payload: { uid, username, page: 1, runStartedAt },
        priority: SCAN_PRIORITY,
      });
    });
  };
}
