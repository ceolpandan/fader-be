import { and, asc, count, desc, eq, inArray, max, sql, type SQL } from "drizzle-orm";
import { Router, type Request } from "express";
import type { Db } from "../db/client";
import { getDiscogsToken } from "../db/discogs-tokens";
import { digitalMatches, releases, wantlistFolderItems, wantlistItems } from "../db/schema";
import { toDigitalMatchDto } from "../digital/digital-match-dto";
import { DIGITAL_STORE_IDS, type DigitalStoreId } from "../digital/types";
import { DiscogsAuthError } from "../discogs-client";
import { PRICE_CURRENCY, shownPrice } from "../dto/price";
import type {
  WantlistItemDto,
  WantlistPageDto,
  WantlistUnmatchedItemDto,
  WantlistUnmatchedPageDto,
} from "../dto/wantlist.dto";
import type { DiscogsQueue } from "../queue/discogs-queue";
import { NonRetryableError, QueueUnavailableError, QueueWaitTimeoutError } from "../queue/discogs-queue";
import { logger } from "../util/logger";

export interface WantlistRouterDeps {
  db: Db;
  queue: DiscogsQueue;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const UNMATCHED_SOURCE = "Discogs wantlist";

const MAX_SEARCH_LENGTH = 100;
const SORTS = ["numForSale", "-addedAt", "artist", "title"] as const;
type WantlistSort = (typeof SORTS)[number];

/** The lowest availability first; items with no count, and items Discogs gave no date for, go last. */
function orderFor(sort: WantlistSort): SQL[] {
  switch (sort) {
    case "numForSale":
      return [sql`${releases.numForSale} IS NULL`, asc(releases.numForSale), asc(wantlistItems.releaseId)];
    case "-addedAt":
      return [sql`${wantlistItems.addedAt} IS NULL`, desc(wantlistItems.addedAt), asc(wantlistItems.releaseId)];
    case "artist":
      return [asc(releases.artistSort), asc(wantlistItems.releaseId)];
    case "title":
      return [asc(releases.title), asc(wantlistItems.releaseId)];
  }
}

/** A query value that is absent (undefined), a number of 0 or more (whole when `whole`), or "invalid". */
function parseBound(value: unknown, whole: boolean): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") return "invalid";
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && (!whole || Number.isInteger(n)) ? n : "invalid";
}

function parsePaging(req: Request): { page: number; pageSize: number } | { error: string } {
  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.pageSize ?? DEFAULT_PAGE_SIZE);
  if (!Number.isInteger(page) || page < 1) return { error: "page must be a positive integer" };
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return { error: `pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}` };
  }
  return { page, pageSize };
}

/** The signed-in collector's wantlist, as the last sync mirrored it; every query is scoped to their `uid`. */
export function createWantlistRouter(deps: WantlistRouterDeps): Router {
  const router = Router();
  const { db } = deps;

  const matchedCount = (uid: string): number =>
    db
      .select({ n: count() })
      .from(wantlistItems)
      .innerJoin(releases, eq(releases.id, wantlistItems.releaseId))
      .where(eq(wantlistItems.uid, uid))
      .get()!.n;

  const filteredCount = (where: SQL | undefined): number =>
    db
      .select({ n: count() })
      .from(wantlistItems)
      .innerJoin(releases, eq(releases.id, wantlistItems.releaseId))
      .where(where)
      .get()!.n;

  const unmatchedCount = (uid: string): number =>
    db
      .select({ n: count() })
      .from(wantlistItems)
      .leftJoin(releases, eq(releases.id, wantlistItems.releaseId))
      .where(sql`${wantlistItems.uid} = ${uid} AND ${releases.id} IS NULL`)
      .get()!.n;

  router.get("/", (req, res) => {
    const uid = req.user!.uid;
    const paging = parsePaging(req);
    if ("error" in paging) {
      res.status(400).json({ error: paging.error });
      return;
    }
    const sort = (req.query.sort ?? "numForSale") as string;
    if (!SORTS.includes(sort as WantlistSort)) {
      res.status(400).json({ error: `sort must be one of ${SORTS.join(", ")}` });
      return;
    }

    const hideNone = req.query.hideNoneForSale === "true";
    const hideFoldered = req.query.hideFoldered === "true";
    const availableOn = req.query.availableOn;
    if (availableOn !== undefined && !DIGITAL_STORE_IDS.includes(availableOn as DigitalStoreId)) {
      res.status(400).json({ error: `availableOn must be one of ${DIGITAL_STORE_IDS.join(", ")}` });
      return;
    }
    let folderId: number | undefined;
    if (req.query.folderId !== undefined) {
      folderId = Number(req.query.folderId);
      if (!Number.isInteger(folderId) || folderId < 1) {
        res.status(400).json({ error: "folderId must be a positive integer" });
        return;
      }
      if (hideFoldered) {
        res.status(400).json({ error: "folderId and hideFoldered cannot be used together" });
        return;
      }
    }

    const ranges = {
      minForSale: parseBound(req.query.minForSale, true),
      maxForSale: parseBound(req.query.maxForSale, true),
      minPrice: parseBound(req.query.minPrice, false),
      maxPrice: parseBound(req.query.maxPrice, false),
      haveMin: parseBound(req.query.haveMin, true),
    };
    for (const [name, bound] of Object.entries(ranges)) {
      if (bound === "invalid") {
        const kind = name.endsWith("Price") ? "a number" : "a whole number";
        res.status(400).json({ error: `${name} must be ${kind} of 0 or more` });
        return;
      }
    }
    const { minForSale, maxForSale, minPrice, maxPrice, haveMin } = ranges as Record<keyof typeof ranges, number | undefined>;
    if (
      (minForSale !== undefined && maxForSale !== undefined && minForSale > maxForSale) ||
      (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice)
    ) {
      res.status(400).json({ error: "A minimum cannot be above its maximum" });
      return;
    }

    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (req.query.q !== undefined && (typeof req.query.q !== "string" || search.length > MAX_SEARCH_LENGTH)) {
      res.status(400).json({ error: `q must be text of at most ${MAX_SEARCH_LENGTH} characters` });
      return;
    }

    const conditions: SQL[] = [eq(wantlistItems.uid, uid)];
    // Every word must be in the title or in one of the artist names, in any order, ignoring case.
    for (const word of search.split(/\s+/).filter(Boolean)) {
      const pattern = `%${word.replace(/[\\%_]/g, "\\$&")}%`;
      conditions.push(
        sql`(${releases.title} LIKE ${pattern} ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_each(${releases.artists}) WHERE json_extract(value, '$.name') LIKE ${pattern} ESCAPE '\\'))`,
      );
    }
    // Items with no count yet stay: only a count of 0 is "none for sale".
    if (hideNone) conditions.push(sql`(${releases.numForSale} IS NULL OR ${releases.numForSale} > 0)`);
    // A range leaves out the items it cannot place: no count fetched yet, or no price in PRICE_CURRENCY.
    if (minForSale !== undefined) conditions.push(sql`${releases.numForSale} >= ${minForSale}`);
    if (maxForSale !== undefined) conditions.push(sql`${releases.numForSale} <= ${maxForSale}`);
    if (minPrice !== undefined || maxPrice !== undefined) {
      conditions.push(sql`${releases.lowestPriceCurrency} = ${PRICE_CURRENCY}`);
    }
    if (minPrice !== undefined) conditions.push(sql`${releases.lowestPrice} >= ${minPrice}`);
    if (maxPrice !== undefined) conditions.push(sql`${releases.lowestPrice} <= ${maxPrice}`);
    // Haves come with the release's enrichment: items not enriched with them are left out.
    if (haveMin !== undefined) conditions.push(sql`${releases.haveCount} >= ${haveMin}`);
    if (folderId !== undefined) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM ${wantlistFolderItems} WHERE ${wantlistFolderItems.uid} = ${uid} AND ${wantlistFolderItems.releaseId} = ${wantlistItems.releaseId} AND ${wantlistFolderItems.folderId} = ${folderId})`,
      );
    }
    if (hideFoldered) {
      conditions.push(
        sql`NOT EXISTS (SELECT 1 FROM ${wantlistFolderItems} WHERE ${wantlistFolderItems.uid} = ${uid} AND ${wantlistFolderItems.releaseId} = ${wantlistItems.releaseId})`,
      );
    }
    // Available: the store has the album, or some of its tracks. Unchecked and "none" items go.
    if (availableOn !== undefined) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM ${digitalMatches} WHERE ${digitalMatches.releaseId} = ${wantlistItems.releaseId} AND ${digitalMatches.store} = ${availableOn} AND ${digitalMatches.status} IN ('album', 'tracks'))`,
      );
    }
    const shown = and(...conditions);
    const filtered = conditions.length > 1;

    const rows = db
      .select({
        releaseId: wantlistItems.releaseId,
        title: releases.title,
        year: releases.year,
        formats: releases.formats,
        artists: releases.artists,
        numForSale: releases.numForSale,
        lowestPrice: releases.lowestPrice,
        lowestPriceCurrency: releases.lowestPriceCurrency,
        thumb: releases.thumb,
        addedAt: wantlistItems.addedAt,
      })
      .from(wantlistItems)
      .innerJoin(releases, eq(releases.id, wantlistItems.releaseId))
      .where(shown)
      .orderBy(...orderFor(sort as WantlistSort))
      .limit(paging.pageSize)
      .offset((paging.page - 1) * paging.pageSize)
      .all();

    const matchRows = rows.length
      ? db
          .select()
          .from(digitalMatches)
          .where(inArray(digitalMatches.releaseId, rows.map((row) => row.releaseId)))
          .orderBy(asc(digitalMatches.store))
          .all()
      : [];
    const items: WantlistItemDto[] = rows.map((row) => ({
      ...row,
      ...shownPrice(row.lowestPrice, row.lowestPriceCurrency),
      addedAt: row.addedAt?.toISOString() ?? null,
      digitalMatches: matchRows.filter((m) => m.releaseId === row.releaseId).map(toDigitalMatchDto),
    }));
    const updatedAt = db
      .select({ at: max(releases.numForSaleAt) })
      .from(wantlistItems)
      .innerJoin(releases, eq(releases.id, wantlistItems.releaseId))
      .where(eq(wantlistItems.uid, uid))
      .get()?.at;

    const body: WantlistPageDto = {
      items,
      ...paging,
      total: filtered ? filteredCount(shown) : matchedCount(uid),
      wantlistCount: matchedCount(uid),
      unmatchedCount: unmatchedCount(uid),
      availabilityUpdatedAt: updatedAt?.toISOString() ?? null,
    };
    res.set("Cache-Control", "no-store").json(body);
  });

  router.get("/unmatched", (req, res) => {
    const uid = req.user!.uid;
    const paging = parsePaging(req);
    if ("error" in paging) {
      res.status(400).json({ error: paging.error });
      return;
    }

    const rows = db
      .select({
        releaseId: wantlistItems.releaseId,
        title: wantlistItems.title,
        artists: wantlistItems.artists,
        addedAt: wantlistItems.addedAt,
      })
      .from(wantlistItems)
      .leftJoin(releases, eq(releases.id, wantlistItems.releaseId))
      .where(sql`${wantlistItems.uid} = ${uid} AND ${releases.id} IS NULL`)
      .orderBy(sql`${wantlistItems.addedAt} IS NULL`, desc(wantlistItems.addedAt), asc(wantlistItems.releaseId))
      .limit(paging.pageSize)
      .offset((paging.page - 1) * paging.pageSize)
      .all();

    const items: WantlistUnmatchedItemDto[] = rows.map((row) => ({
      ...row,
      source: UNMATCHED_SOURCE,
      addedAt: row.addedAt?.toISOString() ?? null,
    }));
    const body: WantlistUnmatchedPageDto = {
      items,
      ...paging,
      total: unmatchedCount(uid),
      wantlistCount: matchedCount(uid),
    };
    res.set("Cache-Control", "no-store").json(body);
  });

  // Removes the release from the collector's Discogs wantlist and from the mirror of it, so a fade
  // from the wantlist page is not undone by the next sync. It is queued like every Discogs request,
  // at inline priority: a person is waiting on it.
  router.delete("/:releaseId", async (req, res) => {
    const uid = req.user!.uid;
    const releaseId = Number(req.params.releaseId);
    if (!Number.isInteger(releaseId) || releaseId < 1) {
      res.status(400).json({ error: "releaseId must be a positive integer" });
      return;
    }
    const onWantlist = db
      .select({ releaseId: wantlistItems.releaseId })
      .from(wantlistItems)
      .where(and(eq(wantlistItems.uid, uid), eq(wantlistItems.releaseId, releaseId)))
      .get();
    if (!onWantlist) {
      res.status(404).json({ error: "That release is not on your wantlist" });
      return;
    }
    if (!getDiscogsToken(db, uid)) {
      res.status(409).json({ error: "Save a Discogs token in Settings first" });
      return;
    }

    try {
      await deps.queue.enqueueAndWait({
        runId: `wantlist-remove:${uid}`,
        type: "wantlist_remove",
        payload: { uid, releaseId },
      });
    } catch (err) {
      // 400, not 401: the UI treats a 401 from this API as a lost sign-in.
      if (err instanceof DiscogsAuthError) {
        res.status(400).json({ error: "Discogs did not accept your token. Update it in Settings." });
      } else if (err instanceof NonRetryableError) {
        res.status(409).json({ error: "Save a Discogs token in Settings first" });
      } else if (err instanceof QueueUnavailableError) {
        res.status(503).json({ error: "Discogs is unavailable right now. Try again in a moment." });
      } else if (err instanceof QueueWaitTimeoutError) {
        res.status(504).json({ error: "Discogs is busy. Try again in a moment." });
      } else {
        logger.error("Removing a wantlist item failed", err);
        res.status(502).json({ error: "Couldn't remove it from your Discogs wantlist. Try again." });
      }
      return;
    }
    res.status(204).end();
  });

  return router;
}
