import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { releases, sellerInventory } from "../db/schema";
import type { InventoryPagePayload } from "../db/schema";
import type { EnqueueInput, JobHandler } from "../queue/discogs-queue";
import type { DiscogsInventoryPage } from "../types/discogs-api";
import { logger } from "../util/logger";

export interface InventoryPageHandlerDeps {
  db: Db;
  enqueue: (job: EnqueueInput) => number;
  getInventory: (username: string, page: number) => Promise<DiscogsInventoryPage>;
}

export function createInventoryPageHandler(
  deps: InventoryPageHandlerDeps,
): JobHandler<InventoryPagePayload> {
  return async (payload, context) => {
    const { username, page, runStartedAt } = payload;
    const inventoryPage = await deps.getInventory(username, page);
    const now = new Date();

    for (const listing of inventoryPage.listings) {
      const releaseId = listing.release.id;

      deps.db
        .insert(sellerInventory)
        .values({
          sellerUsername: username,
          releaseId,
          status: "active",
          firstSeenAt: now,
          lastSeenAt: now,
          soldAt: null,
        })
        .onConflictDoUpdate({
          target: [sellerInventory.sellerUsername, sellerInventory.releaseId],
          set: { status: "active", lastSeenAt: now, soldAt: null },
        })
        .run();

      const [existingRelease] = deps.db
        .select({ id: releases.id })
        .from(releases)
        .where(eq(releases.id, releaseId))
        .all();

      if (!existingRelease) {
        deps.enqueue({
          runId: context.runId,
          type: "release_detail",
          payload: { releaseId },
        });
      }
    }

    const nextUrl = inventoryPage.pagination.urls.next;
    if (nextUrl) {
      deps.enqueue({
        runId: context.runId,
        type: "inventory_page",
        payload: { username, page: page + 1, runStartedAt },
      });
      return;
    }

    const runStart = new Date(runStartedAt);
    deps.db
      .update(sellerInventory)
      .set({ status: "sold", soldAt: now })
      .where(
        and(
          eq(sellerInventory.sellerUsername, username),
          eq(sellerInventory.status, "active"),
          lt(sellerInventory.lastSeenAt, runStart),
        ),
      )
      .run();

    logger.info(`Finished inventory scan for ${username} (run ${context.runId})`);
  };
}
