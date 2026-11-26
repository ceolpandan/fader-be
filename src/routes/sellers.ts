import { randomUUID } from "node:crypto";
import { and, asc, eq, or, sql, type SQL } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "../db/client";
import { hasDiscogsToken } from "../db/discogs-tokens";
import { isFadedFor } from "../db/fades";
import { discogsQueueJobs, releases, scanListings, scanPasses, sellerInventory, sellers } from "../db/schema";
import type {
  IndexStartedDto,
  IndexingPhase,
  ScanPassDto,
  SellerCoverageDto,
  SellerStatusDto,
  SellerSummaryDto,
} from "../dto/seller.dto";
import { isInventoryCovered, observedItems, observedListings } from "../indexing/coverage";
import { MAX_REACHABLE_ITEMS } from "../indexing/inventory-page-handler";
import {
  NonRetryableError,
  QueueUnavailableError,
  QueueWaitTimeoutError,
  SCAN_PRIORITY,
  type DiscogsQueue,
} from "../queue/discogs-queue";
import { logger } from "../util/logger";

/**
 * Inventory items the run has seen so far: distinct items since its first pass began, out of
 * Discogs' listing total. Once the scan has covered every listing the distinct count is the whole
 * inventory (several copies of a release are one item), so the total drops to it. A run that
 * predates scan passes falls back to what a single pass can reach.
 */
function coverageNumbers(
  db: Db,
  seller: typeof sellers.$inferSelect,
  total: number,
  passes: { startedAt: Date }[],
): SellerCoverageDto {
  if (passes.length === 0) return { reachable: Math.min(total, MAX_REACHABLE_ITEMS), total };
  const since = new Date(Math.min(...passes.map((pass) => pass.startedAt.getTime())));
  const observed = observedItems(db, seller.username, since);
  return seller.currentRunId && isInventoryCovered(total, observedListings(db, seller.currentRunId))
    ? { reachable: observed, total: observed }
    : { reachable: observed, total };
}

/** How much of a seller's inventory the scan reached; null until the first page has told us the total. */
function coverageOf(
  db: Db,
  seller: typeof sellers.$inferSelect,
  passes: { startedAt: Date }[],
): SellerCoverageDto | null {
  if (seller.inventoryTotal === null) return null;
  return coverageNumbers(db, seller, seller.inventoryTotal, passes);
}

/** The seller's active items that are in the catalogue (faded ones included); `extra` narrows them, e.g. to the faded ones. */
function countForSale(db: Db, username: string, ...extra: SQL[]): number {
  return db
    .select({ count: sql<number>`count(*)` })
    .from(sellerInventory)
    .innerJoin(releases, eq(sellerInventory.releaseId, releases.id))
    .where(and(eq(sellerInventory.sellerUsername, username), eq(sellerInventory.status, "active"), ...extra))
    .all()[0]!.count;
}

/** Completed release_detail jobs needed before an ETA is worth showing. */
export const ETA_MIN_SAMPLES = 10;
/** The ETA rate is taken from this many most recently completed jobs. */
export const ETA_WINDOW = 20;
/** A gap this long between completed jobs was a Discogs pause, not the queue's pace. */
const ETA_PAUSE_GAP_MS = 30_000;

/**
 * Time left for `remaining` jobs at the pace of the last ETA_WINDOW completed ones, leaving out
 * gaps that were Discogs pauses. Null until ETA_MIN_SAMPLES have completed. `doneAt` are
 * completion times in ms, in any order.
 */
function estimateEtaSeconds(doneAt: number[], remaining: number): number | null {
  if (doneAt.length < ETA_MIN_SAMPLES) return null;
  const recent = [...doneAt].sort((a, b) => b - a).slice(0, ETA_WINDOW);
  const gaps = recent.slice(1).map((at, i) => recent[i]! - at);
  const paced = gaps.filter((gap) => gap < ETA_PAUSE_GAP_MS);
  if (paced.length === 0) return null;
  const spacingMs = paced.reduce((sum, gap) => sum + gap, 0) / paced.length;
  return Math.round((spacingMs * remaining) / 1000);
}

export interface SellersRouterDeps {
  db: Db;
  queue: DiscogsQueue;
}

/**
 * Seller indexing: a collector types a Discogs username and `fader-be` scans the
 * seller's marketplace inventory with the collector's own token, in as many sort orders as it takes
 * to reach all of it. The releases it finds show on Explore under the `seller` filter.
 */
export function createSellersRouter(deps: SellersRouterDeps): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const { uid } = req.user!;
    const rows = deps.db.select().from(sellers).orderBy(asc(sellers.username)).all();

    const dto: SellerSummaryDto[] = rows.map((row) => {
      const passes = row.currentRunId
        ? deps.db.select().from(scanPasses).where(eq(scanPasses.runId, row.currentRunId)).all()
        : [];
      return {
        username: row.username,
        avatarUrl: row.avatarUrl,
        lastIndexedAt: row.lastIndexedAt?.toISOString() ?? null,
        lastIndexStatus: row.lastIndexStatus,
        forSaleCount: countForSale(deps.db, row.username),
        fadedCount: countForSale(deps.db, row.username, isFadedFor(uid)),
        coverage: coverageOf(deps.db, row, passes),
      };
    });
    res.set("Cache-Control", "no-store").json(dto);
  });

  /** Run the already-known seller again: one transaction, so a crash can't leave it `running` with no job. */
  function restartRun(username: string, uid: string): string {
    const runId = randomUUID();
    const runStartedAt = new Date().toISOString();

    deps.db.transaction(() => {
      deps.db.delete(scanListings).where(eq(scanListings.sellerUsername, username)).run();
      deps.db
        .update(sellers)
        .set({
          lastIndexStatus: "running",
          currentRunId: runId,
          runUid: uid,
          inventoryTotal: null,
          scanPagesTotal: null,
          scanPagesFetched: 0,
          scanCompletedAt: null,
        })
        .where(eq(sellers.username, username))
        .run();

      deps.queue.enqueue({
        runId,
        type: "inventory_page",
        payload: { uid, username, page: 1, runStartedAt },
        priority: SCAN_PRIORITY,
      });
    });
    return runId;
  }

  router.post("/:username/index", async (req, res) => {
    const { uid } = req.user!;
    const typed = req.params.username.trim();
    if (!typed) {
      res.status(400).json({ error: "username must not be empty" });
      return;
    }
    if (!hasDiscogsToken(deps.db, uid)) {
      res.status(409).json({ error: "Add a Discogs token in Settings to index a seller", code: "token_required" });
      return;
    }

    // Discogs usernames are case-insensitive, so `FooBar` and `foobar` are one Seller.
    const [existing] = deps.db
      .select()
      .from(sellers)
      .where(sql`lower(${sellers.username}) = lower(${typed})`)
      .all();

    if (existing) {
      if (existing.lastIndexStatus === "running") {
        res.status(409).json({ error: `Indexing is already running for ${existing.username}`, code: "run_active" });
        return;
      }
      const dto: IndexStartedDto = { username: existing.username, runId: restartRun(existing.username, uid) };
      res.status(202).json(dto);
      return;
    }

    // Unknown to us: ask Discogs first, so a typo never becomes a Seller. The job creates the
    // Seller (under Discogs' casing) and starts the run under this id.
    const runId = randomUUID();
    try {
      await deps.queue.enqueueAndWait({ runId, type: "seller_profile", payload: { uid, username: typed } });
    } catch (err) {
      if (err instanceof NonRetryableError) {
        res.status(404).json({ error: `No Discogs user named '${typed}'` });
      } else if (err instanceof QueueUnavailableError) {
        res.status(503).json({ error: "Discogs unavailable, retrying" });
      } else if (err instanceof QueueWaitTimeoutError) {
        res.status(504).json({ error: "Timed out waiting for Discogs" });
      } else {
        logger.error("Failed to validate seller with Discogs", err);
        res.status(502).json({ error: "Failed to validate seller with Discogs" });
      }
      return;
    }

    const [started] = deps.db.select().from(sellers).where(eq(sellers.currentRunId, runId)).all();
    if (!started) {
      // Another request got this Seller running between our lookup and the job.
      res.status(409).json({ error: `Indexing is already running for ${typed}`, code: "run_active" });
      return;
    }
    const dto: IndexStartedDto = { username: started.username, runId };
    res.status(202).json(dto);
  });

  router.delete("/:username", (req, res) => {
    const { username } = req.params;

    const [seller] = deps.db.select().from(sellers).where(eq(sellers.username, username)).all();
    if (!seller) {
      res.status(404).json({ error: `${username} has never been indexed` });
      return;
    }

    // Only what hangs off this seller goes. Releases are shared across sellers and fades belong
    // to the collector, so both stay. Deleting the run's queued jobs stops it; a job already in
    // flight finds the seller gone (its run id no longer matches) and writes nothing.
    deps.db.transaction(() => {
      deps.db
        .delete(discogsQueueJobs)
        .where(
          or(
            seller.currentRunId ? eq(discogsQueueJobs.runId, seller.currentRunId) : undefined,
            and(
              eq(discogsQueueJobs.type, "inventory_page"),
              sql`json_extract(${discogsQueueJobs.payload}, '$.username') = ${username}`,
            ),
          ),
        )
        .run();
      deps.db.delete(scanPasses).where(eq(scanPasses.sellerUsername, username)).run();
      deps.db.delete(scanListings).where(eq(scanListings.sellerUsername, username)).run();
      deps.db.delete(sellerInventory).where(eq(sellerInventory.sellerUsername, username)).run();
      deps.db.delete(sellers).where(eq(sellers.username, username)).run();
    });

    res.status(204).end();
  });

  router.get("/:username", (req, res) => {
    const { username } = req.params;

    const [seller] = deps.db.select().from(sellers).where(eq(sellers.username, username)).all();
    if (!seller) {
      res.status(404).json({ error: `${username} has never been indexed` });
      return;
    }

    const counts = { pending: 0, processing: 0, done: 0, failed: 0 };
    const doneAt: number[] = [];
    if (seller.currentRunId) {
      const jobs = deps.db
        .select({ status: discogsQueueJobs.status, updatedAt: discogsQueueJobs.updatedAt })
        .from(discogsQueueJobs)
        .where(and(eq(discogsQueueJobs.runId, seller.currentRunId), eq(discogsQueueJobs.type, "release_detail")))
        .all();
      for (const job of jobs) {
        counts[job.status] += 1;
        if (job.status === "done") doneAt.push(job.updatedAt.getTime());
      }
    }

    const passes = seller.currentRunId
      ? deps.db
          .select()
          .from(scanPasses)
          .where(eq(scanPasses.runId, seller.currentRunId))
          .orderBy(asc(scanPasses.id))
          .all()
      : [];
    const scanPassDtos: ScanPassDto[] = passes.map((pass) => ({
      sort: pass.sort,
      order: pass.order,
      status: pass.status,
      pagesPlanned: pass.pagesPlanned,
      pagesFetched: pass.pagesFetched,
      itemsSeen: pass.itemsSeen,
      itemsNew: pass.itemsNew,
      startedAt: pass.startedAt.toISOString(),
      endedAt: pass.endedAt?.toISOString() ?? null,
    }));

    const running = seller.lastIndexStatus === "running";
    const phase: IndexingPhase = !running ? "done" : seller.scanCompletedAt ? "enriching" : "scanning";
    const remaining = counts.pending + counts.processing;
    // The run's work is on the lane of the collector who started it.
    const pause = running && seller.runUid ? deps.queue.getPause(seller.runUid) : null;
    const pauseSeconds = pause ? Math.max(0, (pause.retryAt.getTime() - Date.now()) / 1000) : 0;
    const paceEtaSeconds = phase === "enriching" ? estimateEtaSeconds(doneAt, remaining) : null;
    const etaSeconds = paceEtaSeconds === null ? null : Math.round(paceEtaSeconds + pauseSeconds);

    const dto: SellerStatusDto = {
      username: seller.username,
      lastIndexedAt: seller.lastIndexedAt?.toISOString() ?? null,
      lastIndexStatus: seller.lastIndexStatus,
      currentlyRunning: running,
      totalReleasesFound: counts.pending + counts.processing + counts.done + counts.failed,
      releasesEnriched: counts.done,
      releasesFailed: counts.failed,
      sellerRating: seller.sellerRating,
      sellerNumRatings: seller.sellerNumRatings,
      shipsFromCountry: seller.shipsFromCountry,
      avatarUrl: seller.avatarUrl,
      phase,
      scan:
        seller.scanPagesTotal === null
          ? null
          : { pagesFetched: seller.scanPagesFetched, pagesTotal: seller.scanPagesTotal },
      etaSeconds,
      retryingAt: pause?.retryAt.toISOString() ?? null,
      backoffMs: pause?.backoffMs ?? null,
      scanPasses: scanPassDtos,
      coverage: coverageOf(deps.db, seller, passes),
    };
    res.set("Cache-Control", "no-store").json(dto);
  });

  return router;
}
