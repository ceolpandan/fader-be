import { and, eq, sql, type SQL } from "drizzle-orm";
import { Router, type Response } from "express";
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import { isFadedViaFades, isNotFadedFor } from "../db/fades";
import { getDiscogsToken } from "../db/discogs-tokens";
import { isNotMissing } from "../db/missing";
import { filterOptions, releases, type FilterOptionKind } from "../db/schema";
import type { ReleaseFilterOptionsDto, ReleaseListPageDto } from "../dto/release-list.dto";
import { DiscogsAuthError } from "../discogs-client";
import { mapReleaseRowToDto } from "../dto/mappers";
import {
  NonRetryableError,
  QueueUnavailableError,
  QueueWaitTimeoutError,
  type DiscogsQueue,
} from "../queue/discogs-queue";
import { logger } from "../util/logger";
import { parseReleaseQuery } from "./release-query";
import { rarityHaveMaxOf } from "./settings";

export interface ReleasesRouterDeps {
  db: Db;
  queue: DiscogsQueue;
}

export function createReleasesRouter(deps: ReleasesRouterDeps): Router {
  const router = Router();

  const findRelease = (id: number) =>
    deps.db.select().from(releases).where(eq(releases.id, id)).get();

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

  /** The one static list per catalogue, filled by the importer. An `enriched` parameter from an older client is ignored. */
  router.get("/filter-options", (_req, res) => {
    const rows = deps.db
      .select({ kind: filterOptions.kind, value: filterOptions.value })
      .from(filterOptions)
      .orderBy(filterOptions.kind, filterOptions.position)
      .all();
    const valuesOf = (kind: FilterOptionKind) => rows.filter((row) => row.kind === kind).map((row) => row.value);
    const dto: ReleaseFilterOptionsDto = {
      genres: valuesOf("genre"),
      styles: valuesOf("style"),
      formats: valuesOf("format"),
      countries: valuesOf("country"),
    };
    res.json(dto);
  });

  router.get("/", (req, res) => {
    const { uid } = req.user!;
    const parsed = parseReleaseQuery(req, rarityHaveMaxOf(deps.db, uid));
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { page, pageSize, styleCombinations, orderBy } = parsed.query;
    const filters = styleCombinations ? [...parsed.query.filters, styleCombinations] : parsed.query.filters;

    const total = countReleases(isNotMissing, isNotFadedFor(uid), ...filters);
    const rows = deps.db
      .select({
        releaseId: releases.id,
        title: releases.title,
        year: releases.year,
        country: releases.country,
        genres: releases.genres,
        styles: releases.styles,
        formats: releases.formats,
        ratingAverage: releases.ratingAverage,
        ratingCount: releases.ratingCount,
        artists: releases.artists,
        labels: releases.labels,
        versionCount: releases.versionCount,
      })
      .from(releases)
      .where(and(isNotMissing, isNotFadedFor(uid), ...filters))
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();

    const dto: ReleaseListPageDto = {
      items: rows,
      page,
      pageSize,
      total,
      fadedCount: countReleases(isNotMissing, isFadedViaFades(uid)),
    };
    res.json(dto);
  });

  router.get("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id must be an integer" });
      return;
    }
    sendStoredRelease(id, res);
  });

  /**
   * Fetch one release from Discogs ahead of any queued run, with the collector's own token, and
   * overwrite what is stored for it (rating included).
   */
  router.post("/:id/refresh", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id must be an integer" });
      return;
    }
    const { uid } = req.user!;
    if (!getDiscogsToken(deps.db, uid)) {
      res.status(409).json({ error: "Add a Discogs token in Settings to refresh a release", code: "token_required" });
      return;
    }

    try {
      await deps.queue.enqueueAndWait({
        runId: `inline-${randomUUID()}`,
        type: "release_detail",
        payload: { uid, releaseId: id, once: true },
      });
    } catch (err) {
      if (err instanceof DiscogsAuthError) {
        res.status(409).json({ error: "Discogs rejected your token", code: "token_required" });
      } else if (err instanceof NonRetryableError) {
        res.status(404).json({ error: "Release not found on Discogs" });
      } else if (err instanceof QueueUnavailableError) {
        res.status(503).json({ error: "Discogs unavailable, retrying" });
      } else if (err instanceof QueueWaitTimeoutError) {
        res.status(504).json({ error: "Timed out waiting for release from Discogs" });
      } else {
        logger.error("Failed to refresh release from Discogs", err);
        res.status(502).json({ error: "Failed to fetch release from Discogs" });
      }
      return;
    }
    sendStoredRelease(id, res);
  });

  return router;
}

