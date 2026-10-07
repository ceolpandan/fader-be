import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { Router } from "express";
import type { Db } from "../db/client";
import { isFadedFor, isNotFadedFor } from "../db/fades";
import { discogsQueueJobs, releases, scanPasses, sellerInventory, sellers } from "../db/schema";
import type {
  IndexStartedDto,
  SellerInventoryFacetsDto,
  SellerInventoryPageDto,
  IndexingPhase,
  ScanPassDto,
  SellerStatusDto,
  SellerSummaryDto,
} from "../dto/seller.dto";
import { MAX_REACHABLE_ITEMS } from "../indexing/inventory-page-handler";
import type { DiscogsQueue } from "../queue/discogs-queue";

/**
 * Inventory items the scan reaches. Once it has finished that is what its passes actually saw;
 * until then (or for a run that predates scan passes) it is what the planned passes can reach.
 */
function reachableItems(total: number, passes: { itemsSeen: number }[], scanDone: boolean): number {
  if (passes.length === 0) return Math.min(total, MAX_REACHABLE_ITEMS);
  if (scanDone) return Math.min(total, passes.reduce((sum, pass) => sum + pass.itemsSeen, 0));
  return Math.min(total, MAX_REACHABLE_ITEMS * (total > MAX_REACHABLE_ITEMS ? 2 : 1));
}

/** How much of a seller's inventory the scan reached; null until the first page has told us the total. */
function coverageOf(
  seller: typeof sellers.$inferSelect,
  passes: { itemsSeen: number }[],
): { reachable: number; total: number } | null {
  if (seller.inventoryTotal === null) return null;
  return {
    reachable: reachableItems(seller.inventoryTotal, passes, seller.scanCompletedAt !== null),
    total: seller.inventoryTotal,
  };
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

const SORT_FIELDS = ["title", "year", "artist", "format", "rating"] as const;
type SortField = (typeof SORT_FIELDS)[number];
const SORT_OPTIONS = SORT_FIELDS.flatMap((field) => [field, `-${field}`]) as string[];

export interface SellersRouterDeps {
  db: Db;
  queue: DiscogsQueue;
}

function parseCommaSeparated(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function jsonArrayHasAny(column: SQLiteColumn, values: string[]): SQL {
  const placeholders = sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
  return sql`EXISTS (SELECT 1 FROM json_each(${column}) WHERE value IN (${placeholders}))`;
}

function jsonFormatNameHasAny(column: SQLiteColumn, values: string[]): SQL {
  const placeholders = sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
  return sql`EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_extract(value, '$.name') IN (${placeholders}))`;
}

function jsonArrayHasNone(column: SQLiteColumn, values: string[]): SQL {
  return sql`NOT ${jsonArrayHasAny(column, values)}`;
}

function jsonFormatNameHasNone(column: SQLiteColumn, values: string[]): SQL {
  return sql`NOT ${jsonFormatNameHasAny(column, values)}`;
}

/** The array is non-empty and every value is in the list. */
function jsonArrayOnly(column: SQLiteColumn, values: string[]): SQL {
  const placeholders = sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
  return sql`(json_array_length(${column}) > 0 AND NOT EXISTS (SELECT 1 FROM json_each(${column}) WHERE value NOT IN (${placeholders})))`;
}

function jsonFormatNameOnly(column: SQLiteColumn, values: string[]): SQL {
  const placeholders = sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
  return sql`(json_array_length(${column}) > 0 AND NOT EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_extract(value, '$.name') NOT IN (${placeholders})))`;
}

function sortColumn(field: SortField) {
  switch (field) {
    case "title":
      return releases.title;
    case "year":
      return releases.year;
    case "artist":
      return sql`json_extract(${releases.artists}, '$[0].name')`;
    case "format":
      return sql`json_extract(${releases.formats}, '$[0].name')`;
    case "rating":
      return releases.ratingAverage;
  }
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
        coverage: coverageOf(row, passes),
      };
    });
    res.json(dto);
  });

  router.post("/:username/index", (req, res) => {
    const { username } = req.params;

    const [existing] = deps.db.select().from(sellers).where(eq(sellers.username, username)).all();
    if (existing?.lastIndexStatus === "running") {
      res.status(409).json({ error: `Indexing is already running for ${username}` });
      return;
    }

    const runId = randomUUID();
    const runStartedAt = new Date().toISOString();

    // One transaction (a single connection, so the queue's insert joins it): a crash can't
    // leave the seller `running` with no job to settle the run.
    deps.db.transaction(() => {
      deps.db
        .insert(sellers)
        .values({ username, lastIndexStatus: "running", currentRunId: runId })
        .onConflictDoUpdate({
          target: sellers.username,
          set: {
            lastIndexStatus: "running",
            currentRunId: runId,
            inventoryTotal: null,
            scanPagesTotal: null,
            scanPagesFetched: 0,
            scanCompletedAt: null,
          },
        })
        .run();

      deps.queue.enqueue({
        runId,
        type: "inventory_page",
        payload: { username, page: 1, runStartedAt },
      });
    });

    const dto: IndexStartedDto = { username, runId };
    res.status(202).json(dto);
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
      phase,
      scan:
        seller.scanPagesTotal === null
          ? null
          : { pagesFetched: seller.scanPagesFetched, pagesTotal: seller.scanPagesTotal },
      etaSeconds,
      retryingAt: pause?.retryAt.toISOString() ?? null,
      backoffMs: pause?.backoffMs ?? null,
      scanPasses: scanPassDtos,
      coverage: coverageOf(seller, passes),
    };
    res.json(dto);
  });

  router.get("/:username/inventory/facets", (req, res) => {
    const { username } = req.params;
    const { uid } = req.user!;

    const rows = deps.db
      .select({
        genres: releases.genres,
        styles: releases.styles,
        formats: releases.formats,
        country: releases.country,
      })
      .from(sellerInventory)
      .innerJoin(releases, eq(sellerInventory.releaseId, releases.id))
      .where(and(eq(sellerInventory.sellerUsername, username), isNotFadedFor(uid)))
      .all();

    const genres = new Set<string>();
    const styles = new Set<string>();
    const formats = new Set<string>();
    const countries = new Set<string>();
    for (const row of rows) {
      for (const g of row.genres) genres.add(g);
      for (const s of row.styles) styles.add(s);
      for (const f of row.formats) formats.add(f.name);
      if (row.country) countries.add(row.country);
    }

    const dto: SellerInventoryFacetsDto = {
      genres: [...genres].sort(),
      styles: [...styles].sort(),
      formats: [...formats].sort(),
      countries: [...countries].sort(),
    };
    res.json(dto);
  });

  router.get("/:username/inventory", (req, res) => {
    const { username } = req.params;
    const { uid } = req.user!;

    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 50);
    if (!Number.isInteger(page) || page < 1) {
      res.status(400).json({ error: "page must be a positive integer" });
      return;
    }
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      res.status(400).json({ error: "pageSize must be a positive integer" });
      return;
    }

    const genreFilter = parseCommaSeparated(req.query.genre);
    const styleFilter = parseCommaSeparated(req.query.style);
    const formatFilter = parseCommaSeparated(req.query.format);
    const onlyGenreFilter = parseCommaSeparated(req.query.onlyGenre);
    const onlyStyleFilter = parseCommaSeparated(req.query.onlyStyle);
    const onlyFormatFilter = parseCommaSeparated(req.query.onlyFormat);
    const excludeGenreFilter =parseCommaSeparated(req.query.excludeGenre);
    const excludeStyleFilter = parseCommaSeparated(req.query.excludeStyle);
    const excludeFormatFilter = parseCommaSeparated(req.query.excludeFormat);
    const countryFilter = parseCommaSeparated(req.query.country);

    let yearMin: number | undefined;
    if (req.query.yearMin !== undefined) {
      yearMin = Number(req.query.yearMin);
      if (!Number.isInteger(yearMin)) {
        res.status(400).json({ error: "yearMin must be an integer" });
        return;
      }
    }
    let yearMax: number | undefined;
    if (req.query.yearMax !== undefined) {
      yearMax = Number(req.query.yearMax);
      if (!Number.isInteger(yearMax)) {
        res.status(400).json({ error: "yearMax must be an integer" });
        return;
      }
    }

    const sortParam = (req.query.sort as string | undefined) ?? "title";
    if (!SORT_OPTIONS.includes(sortParam)) {
      res.status(400).json({ error: `sort must be one of ${SORT_OPTIONS.join(", ")}` });
      return;
    }
    const isDescending = sortParam.startsWith("-");
    const sortField = (isDescending ? sortParam.slice(1) : sortParam) as SortField;

    const forSaleConditions = [
      eq(sellerInventory.sellerUsername, username),
      eq(sellerInventory.status, "active"),
    ];
    const conditions = [...forSaleConditions, isNotFadedFor(uid)];
    if (genreFilter.length > 0) conditions.push(jsonArrayHasAny(releases.genres, genreFilter));
    if (styleFilter.length > 0) conditions.push(jsonArrayHasAny(releases.styles, styleFilter));
    if (formatFilter.length > 0) conditions.push(jsonFormatNameHasAny(releases.formats, formatFilter));
    if (onlyGenreFilter.length > 0) conditions.push(jsonArrayOnly(releases.genres, onlyGenreFilter));
    if (onlyStyleFilter.length > 0) conditions.push(jsonArrayOnly(releases.styles, onlyStyleFilter));
    if (onlyFormatFilter.length > 0) conditions.push(jsonFormatNameOnly(releases.formats, onlyFormatFilter));
    if (excludeGenreFilter.length > 0) conditions.push(jsonArrayHasNone(releases.genres, excludeGenreFilter));
    if (excludeStyleFilter.length > 0) conditions.push(jsonArrayHasNone(releases.styles, excludeStyleFilter));
    if (excludeFormatFilter.length > 0) {
      conditions.push(jsonFormatNameHasNone(releases.formats, excludeFormatFilter));
    }
    if (countryFilter.length > 0) conditions.push(inArray(releases.country, countryFilter));
    if (yearMin !== undefined) conditions.push(gte(releases.year, yearMin));
    if (yearMax !== undefined) conditions.push(lte(releases.year, yearMax));
    const whereClause = and(...conditions);

    const total = deps.db
      .select({ count: sql<number>`count(*)` })
      .from(sellerInventory)
      .innerJoin(releases, eq(sellerInventory.releaseId, releases.id))
      .where(whereClause)
      .all()[0]!.count;

    const forSaleCount = countForSale(deps.db, username);
    const fadedCount = countForSale(deps.db, username, isFadedFor(uid));

    const orderExpr = sortColumn(sortField);
    const orderBy = isDescending ? desc(orderExpr) : asc(orderExpr);
    // Unrated releases are noise at either end of a rating sort, so they always go last.
    const nullsLast = sortField === "rating" ? [sql`${orderExpr} IS NULL`] : [];

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
      .orderBy(...nullsLast, orderBy, sellerInventory.releaseId)
      .limit(pageSize)
      .offset((page - 1) * pageSize)
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
