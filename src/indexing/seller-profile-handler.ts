import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { sellers, type SellerProfilePayload } from "../db/schema";
import { DiscogsNotFoundError } from "../discogs-client";
import { NonRetryableError, SCAN_PRIORITY, type EnqueueInput, type JobHandler } from "../queue/discogs-queue";
import type { DiscogsUserProfile } from "../types/discogs-api";

export interface SellerProfileHandlerDeps {
  db: Db;
  enqueue: (job: EnqueueInput) => number;
  getUserProfile: (username: string) => Promise<DiscogsUserProfile>;
}

/**
 * Confirms the Discogs user exists before we keep anything about them. Only then is the Seller
 * created, under the casing Discogs reports, and its run started with the job's own `runId`
 * so the caller can find what was started. A Seller that is already running is left alone.
 */
export function createSellerProfileHandler(
  deps: SellerProfileHandlerDeps,
): JobHandler<SellerProfilePayload> {
  return async (payload, context) => {
    let profile: DiscogsUserProfile;
    try {
      profile = await deps.getUserProfile(payload.username);
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
        .values({ username, lastIndexStatus: "running", currentRunId: context.runId })
        .onConflictDoUpdate({
          target: sellers.username,
          set: {
            lastIndexStatus: "running",
            currentRunId: context.runId,
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
        payload: { username, page: 1, runStartedAt },
        priority: SCAN_PRIORITY,
      });
    });
  };
}

