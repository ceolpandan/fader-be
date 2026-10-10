import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "../db/client";
import { isFadedFor, isNotFadedFor } from "../db/fades";
import { discogsQueueJobs, releases, scanListings, scanPasses, sellerInventory, sellerListings, sellers } from "../db/schema";
import type {
  IndexStartedDto,
  SellerPreviewDto,
  SellerInventoryFacetsDto,
  SellerInventoryPageDto,
  IndexingPhase,
  ScanPassDto,
  SellerStatusDto,
  SellerSummaryDto,
} from "../dto/seller.dto";
import { isInventoryCovered, observedItems, observedListings } from "../indexing/coverage";
import { MAX_REACHABLE_ITEMS } from "../indexing/inventory-page-handler";
import { DiscogsNotFoundError, DiscogsTransientError, getInventory, getUserProfile } from "../discogs-client";
import type { DiscogsInventoryPage, DiscogsUserProfile } from "../types/discogs-api";
import {
  PACING_MS,
  NonRetryableError,
  QueueUnavailableError,
  QueueWaitTimeoutError,
  SCAN_PRIORITY,
  type DiscogsQueue,
} from "../queue/discogs-queue";
import { logger } from "../util/logger";
import {
  countCurrencies,
  countFacets,
  matchesPrice,
  priceBoundaries,
  priceBuckets,
  type ListingPrice,
} from "./facets";
import { parseReleaseQuery, priceFilterSql } from "./release-query";

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
): { reachable: number; total: number } {
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
): { reachable: number; total: number } | null {
  if (seller.inventoryTotal === null) return null;
  return coverageNumbers(db, seller, seller.inventoryTotal, passes);
}

/** The seller's active, enriched items (faded ones included); `extra` narrows them, e.g. to the faded ones. */
function countForSale(db: Db, username: string, ...extra: SQL[]): number {
  return db
    .select({ count: sql<number>`count(*)` })
    .from(sellerInventory)
    .innerJoin(releases, eq(sellerInventory.releaseId, releases.id))
    .where(
      and(
        eq(sellerInventory.sellerUsername, username),
        eq(sellerInventory.status, "active"),
        ...extra,
      ),
    )
    .all()[0]!.count;
}

/** Completed release_detail jobs needed before an ETA is worth showing. */
export const ETA_MIN_SAMPLES = 10;
/** The ETA rate is taken from this many most recently completed jobs. */
export const ETA_WINDOW = 20;
/** A gap this long between completed jobs was a Discogs pause, not the queue's pace. */
const ETA_PAUSE_GAP_MS = 30_000;


/** The Discogs reads a preview makes directly (not through the queue). */
export interface DiscogsReads {
  getUserProfile: (username: string) => Promise<DiscogsUserProfile>;
  getInventory: (username: string, page: number) => Promise<DiscogsInventoryPage>;
}

export interface SellersRouterDeps {
  db: Db;
  queue: DiscogsQueue;
  discogs?: DiscogsReads;
}

/** Each listing costs one release request and every 100 listings one inventory page, at PACING_MS apiece. */
function estimateIndexingSeconds(numForSale: number): number {
  const requests = numForSale + Math.ceil(numForSale / 100);
  return Math.round((requests * PACING_MS) / 1000);
}


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

export function createSellersRouter(deps: SellersRouterDeps): Router {
  const router = Router();

  const discogs: DiscogsReads = deps.discogs ?? { getUserProfile, getInventory };

  router.get("/:username/preview", async (req, res) => {
    const typed = req.params.username.trim();
    if (!typed) {
      res.status(400).json({ error: "username must not be empty" });
      return;
    }

    let profile: DiscogsUserProfile;
    try {
      profile = await discogs.getUserProfile(typed);
    } catch (err) {
      if (err instanceof DiscogsNotFoundError) {
        res.status(404).json({ error: `No Discogs user named '${typed}'` });
      } else if (err instanceof DiscogsTransientError) {
        res.status(503).json({ error: "Discogs unavailable, try again" });
      } else {
        logger.error("Failed to preview seller with Discogs", err);
        res.status(502).json({ error: "Failed to preview seller with Discogs" });
      }
      return;
    }

    const numForSale = profile.num_for_sale ?? 0;
    let shipsFromCountry: string | null = null;
    if (numForSale > 0) {
      try {
        const page = await discogs.getInventory(profile.username, 1);
        shipsFromCountry = page.listings[0]?.ships_from ?? null;
      } catch (err) {
        logger.error("Could not read a listing for the seller preview", err);
      }
    }

    const hasRatings = (profile.seller_num_ratings ?? 0) > 0;
    const dto: SellerPreviewDto = {
      username: profile.username,
      avatarUrl: profile.avatar_url || null,
      sellerRating: hasRatings ? (profile.seller_rating ?? null) : null,
      sellerNumRatings: hasRatings ? (profile.seller_num_ratings ?? null) : null,
      shipsFromCountry,
      numForSale,
      marketplaceSuspended: profile.marketplace_suspended === true,
      estimatedSeconds: estimateIndexingSeconds(numForSale),
    };
    res.json(dto);
  });

  router.get("/", (req, res) => {
    const { uid } = req.user!;
    const rows = deps.db.select().from(sellers).all();

    const dto: SellerSummaryDto[] = rows.map((row) => {
      const passes = row.currentRunId
        ? deps.db.select().from(scanPasses).where(eq(scanPasses.runId, row.currentRunId)).all()
        : [];
      return {
        username: row.username,
        lastIndexedAt: row.lastIndexedAt?.toISOString() ?? null,
        lastIndexStatus: row.lastIndexStatus,
        forSaleCount: countForSale(deps.db, row.username),
        fadedCount: countForSale(deps.db, row.username, isFadedFor(uid)),
        coverage: coverageOf(deps.db, row, passes),
      };
    });
    res.json(dto);
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
        payload: { username, page: 1, runStartedAt, uid },
        priority: SCAN_PRIORITY,
      });
    });
    return runId;
  }

  router.post("/:username/index", async (req, res) => {
    const typed = req.params.username.trim();
    if (!typed) {
      res.status(400).json({ error: "username must not be empty" });
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
        res.status(409).json({ error: `Indexing is already running for ${existing.username}` });
        return;
      }
      const dto: IndexStartedDto = { username: existing.username, runId: restartRun(existing.username, req.user!.uid) };
      res.status(202).json(dto);
      return;
    }

    // Unknown to us: ask Discogs first, so a typo never becomes a Seller. The job creates the
    // Seller (under Discogs' casing) and starts the run under this id.
    const runId = randomUUID();
    try {
      await deps.queue.enqueueAndWait({ runId, type: "seller_profile", payload: { username: typed, uid: req.user!.uid } });
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
      res.status(409).json({ error: `Indexing is already running for ${typed}` });
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
      deps.db.delete(sellerListings).where(eq(sellerListings.sellerUsername, username)).run();
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
        .where(
          and(
            eq(discogsQueueJobs.runId, seller.currentRunId),
            eq(discogsQueueJobs.type, "release_detail"),
          ),
        )
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
    const pause = running ? deps.queue.getPause() : null;
    const pauseSeconds = pause ? Math.max(0, (pause.retryAt.getTime() - Date.now()) / 1000) : 0;
    const paceEtaSeconds = phase === "enriching" ? estimateEtaSeconds(doneAt, remaining) : null;
    const etaSeconds = paceEtaSeconds === null ? null : Math.round(paceEtaSeconds + pauseSeconds);

    const dto: SellerStatusDto = {
      username: seller.username,
      lastIndexedAt: seller.lastIndexedAt?.toISOString() ?? null,
      lastIndexStatus: seller.lastIndexStatus,
      currentlyRunning: seller.lastIndexStatus === "running",
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
    res.json(dto);
  });

  router.get("/:username/inventory/facets", (req, res) => {
    const { username } = req.params;
    const { uid } = req.user!;

    const parsed = parseReleaseQuery(req);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { filters, price, currency: requestedCurrency } = parsed.query;

    const forSale = and(
      eq(sellerInventory.sellerUsername, username),
      eq(sellerInventory.status, "active"),
      isNotFadedFor(uid),
    );
    const listingsOf = (releaseIds: Set<number>) => {
      const listings = deps.db
        .select({
          releaseId: sellerListings.releaseId,
          price: sellerListings.price,
          currency: sellerListings.currency,
        })
        .from(sellerListings)
        .where(eq(sellerListings.sellerUsername, username))
        .all();
      return listings.filter((l) => releaseIds.has(l.releaseId));
    };

    // Counts follow the filters, as the inventory rows do; the currencies and the price
    // boundaries describe the whole inventory, so they stay put while the filters change.
    const inventory = deps.db
      .select({ releaseId: releases.id })
      .from(sellerInventory)
      .innerJoin(releases, eq(sellerInventory.releaseId, releases.id))
      .where(forSale)
      .all();
    const inventoryListings = listingsOf(new Set(inventory.map((row) => row.releaseId)));
    const currencies = countCurrencies(inventoryListings);
    const currency = requestedCurrency ?? currencies[0]?.currency ?? null;

    const matching = deps.db
      .select({
        releaseId: releases.id,
        genres: releases.genres,
        styles: releases.styles,
        formats: releases.formats,
        country: releases.country,
      })
      .from(sellerInventory)
      .innerJoin(releases, eq(sellerInventory.releaseId, releases.id))
      .where(and(forSale, ...filters))
      .all();
    const matchingListings = listingsOf(new Set(matching.map((row) => row.releaseId)));
    const listingsByRelease = new Map<number, ListingPrice[]>();
    for (const listing of matchingListings) {
      listingsByRelease.set(listing.releaseId, [...(listingsByRelease.get(listing.releaseId) ?? []), listing]);
    }
    const inPriceRange = price
      ? matching.filter((row) => matchesPrice(listingsByRelease.get(row.releaseId) ?? [], price))
      : matching;

    const dto: SellerInventoryFacetsDto = {
      ...countFacets(inPriceRange),
      currencies,
      currency,
      priceBuckets:
        currency === null
          ? []
          : priceBuckets(
              priceBoundaries(inventoryListings, currency),
              matching.map((row) => listingsByRelease.get(row.releaseId) ?? []),
              currency,
            ),
    };
    res.json(dto);
  });

  router.get("/:username/inventory", (req, res) => {
    const { username } = req.params;
    const { uid } = req.user!;

    const parsed = parseReleaseQuery(req);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { page, pageSize, filters, orderBy, price } = parsed.query;

    const whereClause = and(
      eq(sellerInventory.sellerUsername, username),
      eq(sellerInventory.status, "active"),
      isNotFadedFor(uid),
      ...filters,
      price ? priceFilterSql(username, price) : undefined,
    );

    const total = deps.db
      .select({ count: sql<number>`count(*)` })
      .from(sellerInventory)
      .innerJoin(releases, eq(sellerInventory.releaseId, releases.id))
      .where(whereClause)
      .all()[0]!.count;

    const forSaleCount = countForSale(deps.db, username);
    const fadedCount = countForSale(deps.db, username, isFadedFor(uid));

    const rows = deps.db
      .select({
        releaseId: sellerInventory.releaseId,
        title: releases.title,
        thumb: releases.thumb,
        year: releases.year,
        country: releases.country,
        genres: releases.genres,
        styles: releases.styles,
        formats: releases.formats,
        ratingAverage: releases.ratingAverage,
        ratingCount: releases.ratingCount,
        haves: releases.haves,
        wants: releases.wants,
        artists: releases.artists,
        status: sellerInventory.status,
        firstSeenAt: sellerInventory.firstSeenAt,
        soldAt: sellerInventory.soldAt,
      })
      .from(sellerInventory)
      .innerJoin(releases, eq(sellerInventory.releaseId, releases.id))
      .where(whereClause)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();

    const listingRows =
      rows.length === 0
        ? []
        : deps.db
            .select()
            .from(sellerListings)
            .where(
              and(
                eq(sellerListings.sellerUsername, username),
                inArray(
                  sellerListings.releaseId,
                  rows.map((row) => row.releaseId),
                ),
              ),
            )
            .orderBy(asc(sellerListings.currency), asc(sellerListings.price), asc(sellerListings.listingId))
            .all();

    const dto: SellerInventoryPageDto = {
      items: rows.map((row) => ({
        releaseId: row.releaseId,
        title: row.title,
        thumb: row.thumb,
        year: row.year,
        country: row.country,
        genres: row.genres,
        styles: row.styles,
        formats: row.formats,
        ratingAverage: row.ratingAverage,
        ratingCount: row.ratingCount,
        haves: row.haves,
        wants: row.wants,
        artists: row.artists,
        status: row.status,
        firstSeenAt: row.firstSeenAt.toISOString(),
        soldAt: row.soldAt?.toISOString() ?? null,
        listings: listingRows
          .filter((listing) => listing.releaseId === row.releaseId)
          .map((listing) => ({
            id: listing.listingId,
            mediaCondition: listing.mediaCondition,
            sleeveCondition: listing.sleeveCondition,
            price: listing.price,
            currency: listing.currency,
          })),
      })),
      page,
      pageSize,
      total,
      forSaleCount,
      fadedCount,
    };
    res.json(dto);
  });

  return router;
}
