import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { discogsQueueJobs, releases, scanPasses, sellerInventory, sellers } from "../db/schema";
import type {
  InventoryPagePayload,
  ReleaseDetailPayload,
  ScanOrder,
  ScanPassStatus,
  ScanSort,
} from "../db/schema";
import {
  DiscogsAuthError,
  DiscogsPaginationCapError,
  DiscogsTransientError,
} from "../discogs-client";
import { MAX_ATTEMPTS, NonRetryableError, SCAN_PRIORITY } from "../queue/discogs-queue";
import type { EnqueueInput, JobHandler } from "../queue/discogs-queue";
import { isInventoryCovered, observedItems } from "./coverage";
import type { DiscogsInventoryPage, DiscogsUserProfile } from "../types/discogs-api";
import { logger } from "../util/logger";

export interface InventoryPageHandlerDeps {
  db: Db;
  enqueue: (job: EnqueueInput) => number;
  getInventory: (
    username: string,
    page: number,
    scan: { sort: string; order: string },
  ) => Promise<DiscogsInventoryPage>;
  getUserProfile?: (username: string) => Promise<DiscogsUserProfile>;
}

/** Best effort: a missing or failing profile must never fail the indexing run. */
async function storeSellerMetadata(
  deps: InventoryPageHandlerDeps,
  username: string,
  inventoryPage: DiscogsInventoryPage,
): Promise<void> {
  const shipsFromCountry = inventoryPage.listings[0]?.ships_from ?? null;
  let sellerRating: number | null = null;
  let sellerNumRatings: number | null = null;

  if (deps.getUserProfile) {
    try {
      const profile = await deps.getUserProfile(username);
      sellerRating = profile.seller_rating ?? null;
      sellerNumRatings = profile.seller_num_ratings ?? null;
    } catch (error) {
      logger.warn(`Could not fetch Discogs profile for ${username}: ${String(error)}`);
    }
  }

  deps.db
    .update(sellers)
    .set({ sellerRating, sellerNumRatings, shipsFromCountry })
    .where(eq(sellers.username, username))
    .run();
}

/** Discogs only serves the first 100 pages (of 100 listings) of another seller's inventory. */
export const MAX_SCAN_PAGES = 100;
export const PAGE_SIZE = 100;
/** Inventory items one sorted pass can reach. */
export const MAX_REACHABLE_ITEMS = MAX_SCAN_PAGES * PAGE_SIZE;

interface ScanPassSpec {
  sort: ScanSort;
  order: ScanOrder;
}

/**
 * The passes a scan walks, in order, until the whole inventory has been seen. Each sort order
 * reaches a different 10,000 items of a seller that is over the cap. Listed first after `artist`:
 * it is the sort most likely to catch new stock.
 */
export const SCAN_PASSES: readonly ScanPassSpec[] = (
  ["artist", "listed", "label", "catno", "item", "price", "audio"] as const
).flatMap((sort) => [
  { sort, order: "asc" as const },
  { sort, order: "desc" as const },
]);

/**
 * Pages a pass will fetch. The ascending pass takes everything Discogs lets it; the descending
 * pass only reaches for what the ascending one could not (the far end of the sort), so it plans
 * nothing for an inventory that fits in the ascending pass.
 */
export function passPagesPlanned(order: ScanOrder, items: number, pages: number): number {
  if (order === "asc") return Math.min(pages, MAX_SCAN_PAGES);
  return Math.min(MAX_SCAN_PAGES, Math.ceil(Math.max(0, items - MAX_REACHABLE_ITEMS) / PAGE_SIZE));
}

/** Pages the whole scan will fetch if no pass is skipped; it usually stops sooner. */
export function scanPagesPlanned(items: number, pages: number): number {
  return SCAN_PASSES.reduce((sum, pass) => sum + passPagesPlanned(pass.order, items, pages), 0);
}

/** The pass after `current` that still has pages to fetch, or null when the list is exhausted. */
function nextPass(current: ScanPassSpec, items: number): ScanPassSpec | null {
  const pages = Math.ceil(items / PAGE_SIZE);
  const index = SCAN_PASSES.findIndex(
    (pass) => pass.sort === current.sort && pass.order === current.order,
  );
  return (
    SCAN_PASSES.slice(index + 1).find((pass) => passPagesPlanned(pass.order, items, pages) > 0) ??
    null
  );
}

/**
 * Queue a `release_detail` job for every release this run has seen that we don't have yet and
 * haven't already queued. Running this after each pass lets enrichment start while later passes
 * still scan.
 */
function enqueueNewReleases(
  deps: InventoryPageHandlerDeps,
  username: string,
  runId: string,
  runStartedAt: Date,
): number {
  const queued = new Set(
    deps.db
      .select({ payload: discogsQueueJobs.payload })
      .from(discogsQueueJobs)
      .where(and(eq(discogsQueueJobs.runId, runId), eq(discogsQueueJobs.type, "release_detail")))
      .all()
      .map((job) => (job.payload as ReleaseDetailPayload).releaseId),
  );

  const unknown = deps.db
    .select({ releaseId: sellerInventory.releaseId })
    .from(sellerInventory)
    .where(
      and(
        eq(sellerInventory.sellerUsername, username),
        gte(sellerInventory.lastSeenAt, runStartedAt),
        sql`${sellerInventory.releaseId} NOT IN (SELECT ${releases.id} FROM ${releases})`,
      ),
    )
    .all()
    .filter(({ releaseId }) => !queued.has(releaseId));

  for (const { releaseId } of unknown) {
    deps.enqueue({ runId, type: "release_detail", payload: { releaseId } });
  }
  return unknown.length;
}

/** The scan is over: nothing more will be queued for enrichment. */
function finishScan(deps: InventoryPageHandlerDeps, username: string, runId: string): void {
  deps.db
    .update(sellers)
    .set({ scanCompletedAt: new Date() })
    .where(eq(sellers.username, username))
    .run();

  logger.info(`Finished inventory scan for ${username} (run ${runId})`);
}

export function createInventoryPageHandler(
  deps: InventoryPageHandlerDeps,
): JobHandler<InventoryPagePayload> {
  return async (payload, context) => {
    const { username, page, runStartedAt } = payload;
    const sort = payload.sort ?? "artist";
    const order = payload.order ?? "asc";
    const passKey = and(
      eq(scanPasses.runId, context.runId),
      eq(scanPasses.sort, sort),
      eq(scanPasses.order, order),
    );

    /** The seller was removed (or reindexed) while this job waited or ran: it must write nothing. */
    const isCurrentRun = (): boolean => {
      const [seller] = deps.db
        .select({ currentRunId: sellers.currentRunId })
        .from(sellers)
        .where(eq(sellers.username, username))
        .all();
      return seller?.currentRunId === context.runId;
    };
    if (!isCurrentRun()) return;

    const runStart = new Date(runStartedAt);
    const isFirstPass = sort === SCAN_PASSES[0]!.sort && order === SCAN_PASSES[0]!.order;

    /**
     * Close this pass, queue the releases it found for enrichment, then start the next pass
     * unless the whole inventory has been seen or the passes are used up.
     */
    const endPass = (status: ScanPassStatus): void => {
      deps.db.update(scanPasses).set({ status, endedAt: new Date() }).where(passKey).run();
      const toEnrich = enqueueNewReleases(deps, username, context.runId, runStart);
      logger.info(
        `Pass ${sort} ${order} for ${username} ${status} (run ${context.runId}): ${toEnrich} release(s) to enrich`,
      );

      const [seller] = deps.db.select().from(sellers).where(eq(sellers.username, username)).all();
      const total = seller?.inventoryTotal ?? 0;
      const passes = deps.db.select().from(scanPasses).where(eq(scanPasses.runId, context.runId)).all();
      const covered = isInventoryCovered(total, observedItems(deps.db, username, runStart), passes);

      const next = covered ? null : nextPass({ sort, order }, total);
      if (!next) {
        finishScan(deps, username, context.runId);
        return;
      }
      deps.enqueue({
        runId: context.runId,
        type: "inventory_page",
        payload: { username, page: 1, runStartedAt, sort: next.sort, order: next.order },
        priority: SCAN_PRIORITY,
      });
    };

    /** A page that keeps failing costs its pass, not the run, once page 1 has told us the total. */
    const failsPassOnly = (error: unknown): boolean => {
      if (error instanceof DiscogsTransientError || error instanceof DiscogsAuthError) return false;
      if (isFirstPass && page === 1) return false;
      return error instanceof NonRetryableError || (context.attempt ?? 1) >= MAX_ATTEMPTS;
    };

    let inventoryPage: DiscogsInventoryPage;
    try {
      inventoryPage = await deps.getInventory(username, page, { sort, order });
    } catch (error) {
      if (!isCurrentRun()) return;
      if (error instanceof DiscogsPaginationCapError) {
        logger.warn(`Discogs stopped paginating ${username} (${sort} ${order}) at page ${page}`);
        endPass("capped");
        return;
      }
      if (!failsPassOnly(error)) throw error;
      logger.warn(`Abandoning ${sort} ${order} pass for ${username} at page ${page}: ${String(error)}`);
      if (page === 1) {
        // No page of this pass was stored, so there is no pass row to close yet.
        const [seller] = deps.db.select().from(sellers).where(eq(sellers.username, username)).all();
        const total = seller?.inventoryTotal ?? 0;
        deps.db
          .insert(scanPasses)
          .values({
            runId: context.runId,
            sellerUsername: username,
            sort,
            order,
            pagesPlanned: passPagesPlanned(order, total, Math.ceil(total / PAGE_SIZE)),
            status: "running",
            startedAt: new Date(),
          })
          .onConflictDoNothing()
          .run();
      }
      endPass("failed");
      return;
    }
    if (!isCurrentRun()) return;
    const now = new Date();
    const { items, pages } = inventoryPage.pagination;

    if (page === 1) {
      if (isFirstPass) {
        await storeSellerMetadata(deps, username, inventoryPage);
        if (!isCurrentRun()) return;
        deps.db
          .update(sellers)
          .set({ inventoryTotal: items, scanPagesTotal: scanPagesPlanned(items, pages) })
          .where(eq(sellers.username, username))
          .run();
      }
      deps.db
        .insert(scanPasses)
        .values({
          runId: context.runId,
          sellerUsername: username,
          sort,
          order,
          pagesPlanned: passPagesPlanned(order, items, pages),
          status: "running",
          startedAt: now,
        })
        .onConflictDoNothing()
        .run();
    }

    let itemsNew = 0;
    for (const listing of inventoryPage.listings) {
      const [existing] = deps.db
        .select({ lastSeenAt: sellerInventory.lastSeenAt })
        .from(sellerInventory)
        .where(
          and(
            eq(sellerInventory.sellerUsername, username),
            eq(sellerInventory.releaseId, listing.release.id),
          ),
        )
        .all();
      if (!existing || existing.lastSeenAt < runStart) itemsNew += 1;

      deps.db
        .insert(sellerInventory)
        .values({
          sellerUsername: username,
          releaseId: listing.release.id,
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
    }

    deps.db
      .update(scanPasses)
      .set({
        pagesFetched: sql`${scanPasses.pagesFetched} + 1`,
        itemsSeen: sql`${scanPasses.itemsSeen} + ${inventoryPage.listings.length}`,
        itemsNew: sql`${scanPasses.itemsNew} + ${itemsNew}`,
      })
      .where(passKey)
      .run();
    deps.db
      .update(sellers)
      .set({ scanPagesFetched: sql`${sellers.scanPagesFetched} + 1` })
      .where(eq(sellers.username, username))
      .run();

    const [pass] = deps.db.select().from(scanPasses).where(passKey).all();
    const planned = pass?.pagesPlanned ?? passPagesPlanned(order, items, pages);

    if (inventoryPage.pagination.urls.next && page < planned) {
      deps.enqueue({
        runId: context.runId,
        type: "inventory_page",
        payload: { username, page: page + 1, runStartedAt, sort, order },
        priority: SCAN_PRIORITY,
      });
      return;
    }

    endPass("done");
  };
}
