import { and, eq, sql, type SQL } from "drizzle-orm";
import { Router, type Response } from "express";
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import { isFadedFor, isNotFadedFor } from "../db/fades";
import { releases } from "../db/schema";
import type { ReleaseFacetsDto, ReleaseListPageDto } from "../dto/seller.dto";
import { mapReleaseRowToDto } from "../dto/mappers";
import {
  NonRetryableError,
  QueueUnavailableError,
  QueueWaitTimeoutError,
  type DiscogsQueue,
} from "../queue/discogs-queue";
import { logger } from "../util/logger";
import { countFacets } from "./facets";
import { parseReleaseQuery } from "./release-query";

export interface ReleasesRouterDeps {
  db: Db;
  queue: DiscogsQueue;
}

export function createReleasesRouter(deps: ReleasesRouterDeps): Router {
  const router = Router();

  const findRelease = (id: number) =>
    deps.db.select().from(releases).where(eq(releases.id, id)).get();

  /**
   * Fetch the release live from Discogs through the priority queue lane; the queue handler
   * overwrites the stored row. Returns false after sending the error response if that failed.
   */
  async function fetchAndSave(id: number, res: Response): Promise<boolean> {
    try {
      await deps.queue.enqueueAndWait({
        runId: `inline-${randomUUID()}`,
        type: "release_detail",
        payload: { releaseId: id },
      });
      return true;
    } catch (err) {
      if (err instanceof NonRetryableError) {
        res.status(404).json({ error: "Release not found" });
      } else if (err instanceof QueueUnavailableError) {
        res.status(503).json({ error: "Discogs unavailable, retrying" });
      } else if (err instanceof QueueWaitTimeoutError) {
        res.status(504).json({ error: "Timed out waiting for release from Discogs" });
      } else {
        logger.error("Failed to fetch release from Discogs", err);
        res.status(502).json({ error: "Failed to fetch release from Discogs" });
      }
      return false;
    }
  }

  function sendStoredRelease(id: number, res: Response): void {
    const row = findRelease(id);
    if (!row) {
      res.status(404).json({ error: "Release not found" });
      return;
    }
    res.json(mapReleaseRowToDto(row));
  }

  const countReleases = (...where: SQL[]): number =>
    deps.db
      .select({ count: sql<number>`count(*)` })
      .from(releases)
      .where(and(...where))
      .all()[0]!.count;

  router.get("/facets", (req, res) => {
    const parsed = parseReleaseQuery(req);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const rows = deps.db
      .select({
        genres: releases.genres,
        styles: releases.styles,
        formats: releases.formats,
        country: releases.country,
      })
      .from(releases)
      .where(and(isNotFadedFor(req.user!.uid), ...parsed.query.filters))
      .all();
    const dto: ReleaseFacetsDto = countFacets(rows);
    res.json(dto);
  });

  router.get("/", (req, res) => {
    const { uid } = req.user!;
    const parsed = parseReleaseQuery(req);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { page, pageSize, styleCombinations, orderBy } = parsed.query;
    const filters = styleCombinations ? [...parsed.query.filters, styleCombinations] : parsed.query.filters;

    const total = countReleases(isNotFadedFor(uid), ...filters);
    const rows = deps.db
      .select({
        releaseId: releases.id,
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
      })
      .from(releases)
      .where(and(isNotFadedFor(uid), ...filters))
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();

    const dto: ReleaseListPageDto = {
      items: rows,
      page,
      pageSize,
      total,
      enrichedCount: countReleases(),
      fadedCount: countReleases(isFadedFor(uid)),
    };
    res.json(dto);
  });

  router.get("/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id must be an integer" });
      return;
    }

    if (!findRelease(id) && !(await fetchAndSave(id, res))) return;
    sendStoredRelease(id, res);
  });

  router.post("/:id/refresh", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id must be an integer" });
      return;
    }

    if (!(await fetchAndSave(id, res))) return;
    sendStoredRelease(id, res);
  });

  return router;
}
