import { and, asc, count, eq, inArray, type SQL } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "../db/client";
import { getDiscogsToken } from "../db/discogs-tokens";
import { isNotMissing } from "../db/missing";
import { releases, scrapeReleases, scrapes, scrapeSearchMatches, scrapeUnmatched } from "../db/schema";
import type {
  AttachReleaseRequestDto,
  CreateScrapeRequestDto,
  RenameScrapeRequestDto,
  ScrapeDto,
  ScrapeSearchMatchesDto,
  ScrapeUnmatchedDto,
  SearchScrapeRequestDto,
  SearchScrapeResponseDto,
} from "../dto/scrape.dto";
import type { DiscogsQueue } from "../queue/discogs-queue";
import { matchScrapeLines } from "../scrapes/match-scrape";
import { parseLines } from "../scrapes/normalise";
import { queueScrapeSearches, scrapeSearchRunId, unlinkSearchMatch } from "../scrapes/scrape-search";
import { logger } from "../util/logger";
import { fetchReleaseFromDiscogs } from "./fetch-release";

export interface ScrapesRouterDeps {
  db: Db;
  queue: DiscogsQueue;
}

const MAX_NAME_LENGTH = 200;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_LINES = 5000;

function parseName(value: unknown): { name: string } | { error: string } {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return { error: "name must not be empty" };
  if (name.length > MAX_NAME_LENGTH) return { error: `name must be at most ${MAX_NAME_LENGTH} characters` };
  return { name };
}

/** Uploads to match at once per collector are not limited, but the scan holds the server's attention in slices. */
export function createScrapesRouter(deps: ScrapesRouterDeps): Router {
  const router = Router();
  const { db } = deps;

  const nameTaken = (uid: string, name: string, exceptId?: number): boolean => {
    const row = db
      .select({ id: scrapes.id })
      .from(scrapes)
      .where(and(eq(scrapes.uid, uid), eq(scrapes.name, name)))
      .get();
    return row !== undefined && row.id !== exceptId;
  };

  const countOf = (table: typeof scrapeReleases | typeof scrapeUnmatched, scrapeId: number): number =>
    db.select({ n: count() }).from(table).where(eq(table.scrapeId, scrapeId)).get()!.n;

  const searchCount = (scrapeId: number, ...conditions: SQL[]): number =>
    db
      .select({ n: count() })
      .from(scrapeSearchMatches)
      .where(and(eq(scrapeSearchMatches.scrapeId, scrapeId), ...conditions))
      .get()!.n;

  const toDto = (row: typeof scrapes.$inferSelect): ScrapeDto => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    releaseCount: countOf(scrapeReleases, row.id),
    unmatchedCount: countOf(scrapeUnmatched, row.id),
    searchingCount: searchCount(row.id, inArray(scrapeSearchMatches.status, ["queued", "fetching"])),
    uncommittedMatchCount: searchCount(
      row.id,
      eq(scrapeSearchMatches.status, "matched"),
      eq(scrapeSearchMatches.committed, false),
    ),
  });

  /** Queues searches for the scrape's unmatched lines (all of them, or just the given positions). */
  const searchUnmatched = (uid: string, scrapeId: number, positions?: number[]): number => {
    const lines = db
      .select({ position: scrapeUnmatched.position, line: scrapeUnmatched.line })
      .from(scrapeUnmatched)
      .where(
        positions
          ? and(eq(scrapeUnmatched.scrapeId, scrapeId), inArray(scrapeUnmatched.position, positions))
          : eq(scrapeUnmatched.scrapeId, scrapeId),
      )
      .orderBy(asc(scrapeUnmatched.position))
      .all();
    return queueScrapeSearches(db, deps.queue, uid, scrapeId, lines);
  };

  const ownScrape = (uid: string, rawId: string) => {
    const id = Number(rawId);
    if (!Number.isInteger(id)) return undefined;
    return db
      .select()
      .from(scrapes)
      .where(and(eq(scrapes.uid, uid), eq(scrapes.id, id)))
      .get();
  };

  router.get("/", (req, res) => {
    const rows = db
      .select()
      .from(scrapes)
      .where(eq(scrapes.uid, req.user!.uid))
      .orderBy(asc(scrapes.createdAt), asc(scrapes.id))
      .all();
    res.set("Cache-Control", "no-store").json(rows.map(toDto));
  });

  router.post("/", async (req, res) => {
    const body = (req.body ?? {}) as Partial<Record<keyof CreateScrapeRequestDto, unknown>>;
    const parsed = parseName(body.name);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    if (typeof body.text !== "string") {
      res.status(400).json({ error: "text must be a string" });
      return;
    }
    if (Buffer.byteLength(body.text, "utf8") > MAX_TEXT_BYTES) {
      res.status(400).json({ error: `text must be at most ${MAX_TEXT_BYTES / 1024} KB` });
      return;
    }
    const lines = parseLines(body.text);
    if (lines.length === 0) {
      res.status(400).json({ error: "text has no lines" });
      return;
    }
    if (lines.length > MAX_LINES) {
      res.status(400).json({ error: `text must have at most ${MAX_LINES} distinct lines` });
      return;
    }

    const { uid } = req.user!;
    if (nameTaken(uid, parsed.name)) {
      res.status(409).json({ error: "You already have a scrape with this name" });
      return;
    }

    try {
      const match = await matchScrapeLines(db, lines);
      const row = db.transaction((tx) => {
        const created = tx
          .insert(scrapes)
          .values({ uid, name: parsed.name, createdAt: new Date() })
          .returning()
          .get();
        for (const releaseId of match.releaseIds) tx.insert(scrapeReleases).values({ scrapeId: created.id, releaseId }).run();
        for (const { position, line } of match.unmatched) {
          tx.insert(scrapeUnmatched).values({ scrapeId: created.id, position, line }).run();
        }
        return created;
      });
      // Searching needs the collector's Discogs token; without one the lines stay unmatched.
      if (getDiscogsToken(db, uid)) searchUnmatched(uid, row.id);
      res.status(201).json(toDto(row));
    } catch (err) {
      // Another upload took the name while this one was matching.
      if (nameTaken(uid, parsed.name)) {
        res.status(409).json({ error: "You already have a scrape with this name" });
        return;
      }
      logger.error("Failed to match a scrape", err);
      res.status(500).json({ error: "Failed to match the scrape" });
    }
  });

  router.patch("/:id", (req, res) => {
    const { uid } = req.user!;
    const body = (req.body ?? {}) as Partial<Record<keyof RenameScrapeRequestDto, unknown>>;
    const parsed = parseName(body.name);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const scrape = ownScrape(uid, req.params.id);
    if (!scrape) {
      res.status(404).json({ error: "Scrape not found" });
      return;
    }
    if (nameTaken(uid, parsed.name, scrape.id)) {
      res.status(409).json({ error: "You already have a scrape with this name" });
      return;
    }
    const row = db.update(scrapes).set({ name: parsed.name }).where(eq(scrapes.id, scrape.id)).returning().get();
    res.json(toDto(row));
  });

  router.delete("/:id", (req, res) => {
    const scrape = ownScrape(req.user!.uid, req.params.id);
    if (!scrape) {
      res.status(404).json({ error: "Scrape not found" });
      return;
    }
    deps.queue.cancelRun(scrapeSearchRunId(scrape.id));
    db.transaction((tx) => {
      tx.delete(scrapeSearchMatches).where(eq(scrapeSearchMatches.scrapeId, scrape.id)).run();
      tx.delete(scrapeReleases).where(eq(scrapeReleases.scrapeId, scrape.id)).run();
      tx.delete(scrapeUnmatched).where(eq(scrapeUnmatched.scrapeId, scrape.id)).run();
      tx.delete(scrapes).where(eq(scrapes.id, scrape.id)).run();
    });
    res.status(204).end();
  });

  router.get("/:id/unmatched", (req, res) => {
    const scrape = ownScrape(req.user!.uid, req.params.id);
    if (!scrape) {
      res.status(404).json({ error: "Scrape not found" });
      return;
    }
    const rows = db
      .select({
        position: scrapeUnmatched.position,
        line: scrapeUnmatched.line,
        searchStatus: scrapeSearchMatches.status,
      })
      .from(scrapeUnmatched)
      .leftJoin(
        scrapeSearchMatches,
        and(
          eq(scrapeSearchMatches.scrapeId, scrapeUnmatched.scrapeId),
          eq(scrapeSearchMatches.position, scrapeUnmatched.position),
        ),
      )
      .where(eq(scrapeUnmatched.scrapeId, scrape.id))
      .orderBy(asc(scrapeUnmatched.position))
      .all();
    const dto: ScrapeUnmatchedDto = {
      lines: rows.map((row) => ({
        position: row.position,
        line: row.line,
        searchStatus: row.searchStatus === "matched" ? null : row.searchStatus,
      })),
    };
    res.set("Cache-Control", "no-store").json(dto);
  });

  /**
   * Searches Discogs for the scrape's unmatched lines: every one not yet searched (or that found
   * nothing or failed), or just the given positions. Needs the collector's Discogs token.
   */
  router.post("/:id/search", (req, res) => {
    const { uid } = req.user!;
    const scrape = ownScrape(uid, req.params.id);
    if (!scrape) {
      res.status(404).json({ error: "Scrape not found" });
      return;
    }
    const { positions } = (req.body ?? {}) as Partial<Record<keyof SearchScrapeRequestDto, unknown>>;
    if (
      positions !== undefined &&
      !(Array.isArray(positions) && positions.every((p) => typeof p === "number" && Number.isInteger(p)))
    ) {
      res.status(400).json({ error: "positions must be a list of integers" });
      return;
    }
    if (!getDiscogsToken(db, uid)) {
      res.status(409).json({ error: "Add a Discogs token in Settings to search Discogs", code: "token_required" });
      return;
    }
    const dto: SearchScrapeResponseDto = { queued: searchUnmatched(uid, scrape.id, positions as number[] | undefined) };
    res.json(dto);
  });

  /** The lines the Discogs search matched, with the release each was linked to. */
  router.get("/:id/search-matches", (req, res) => {
    const scrape = ownScrape(req.user!.uid, req.params.id);
    if (!scrape) {
      res.status(404).json({ error: "Scrape not found" });
      return;
    }
    const rows = db
      .select({
        position: scrapeSearchMatches.position,
        line: scrapeSearchMatches.line,
        releaseId: scrapeSearchMatches.releaseId,
        committed: scrapeSearchMatches.committed,
        title: releases.title,
        artists: releases.artists,
      })
      .from(scrapeSearchMatches)
      .innerJoin(releases, eq(releases.id, scrapeSearchMatches.releaseId))
      .where(and(eq(scrapeSearchMatches.scrapeId, scrape.id), eq(scrapeSearchMatches.status, "matched")))
      .orderBy(asc(scrapeSearchMatches.position))
      .all();
    const dto: ScrapeSearchMatchesDto = {
      matches: rows.map((row) => ({
        position: row.position,
        line: row.line,
        releaseId: row.releaseId!,
        title: row.title,
        artists: row.artists.map((artist) => artist.name),
        committed: row.committed,
      })),
    };
    res.set("Cache-Control", "no-store").json(dto);
  });

  /** Confirms every searched match of the scrape, which clears their markers. */
  router.post("/:id/search-matches/commit", (req, res) => {
    const scrape = ownScrape(req.user!.uid, req.params.id);
    if (!scrape) {
      res.status(404).json({ error: "Scrape not found" });
      return;
    }
    db.update(scrapeSearchMatches)
      .set({ committed: true })
      .where(and(eq(scrapeSearchMatches.scrapeId, scrape.id), eq(scrapeSearchMatches.status, "matched")))
      .run();
    res.json(toDto(scrape));
  });

  const ownMatch = (uid: string, rawId: string, rawPosition: string) => {
    const scrape = ownScrape(uid, rawId);
    const position = Number(rawPosition);
    if (!scrape || !Number.isInteger(position)) return undefined;
    const match = db
      .select({ position: scrapeSearchMatches.position })
      .from(scrapeSearchMatches)
      .where(
        and(
          eq(scrapeSearchMatches.scrapeId, scrape.id),
          eq(scrapeSearchMatches.position, position),
          eq(scrapeSearchMatches.status, "matched"),
        ),
      )
      .get();
    return match ? { scrape, position } : undefined;
  };

  /** Confirms one searched match, which clears its marker. */
  router.post("/:id/search-matches/:position/commit", (req, res) => {
    const found = ownMatch(req.user!.uid, req.params.id, req.params.position);
    if (!found) {
      res.status(404).json({ error: "Searched match not found" });
      return;
    }
    db.update(scrapeSearchMatches)
      .set({ committed: true })
      .where(and(eq(scrapeSearchMatches.scrapeId, found.scrape.id), eq(scrapeSearchMatches.position, found.position)))
      .run();
    res.json(toDto(found.scrape));
  });

  /** Takes a searched match back: the line returns to the unmatched list and is not searched again. */
  router.post("/:id/search-matches/:position/unlink", (req, res) => {
    const found = ownMatch(req.user!.uid, req.params.id, req.params.position);
    if (!found) {
      res.status(404).json({ error: "Searched match not found" });
      return;
    }
    unlinkSearchMatch(db, found.scrape.id, found.position);
    res.json(toDto(found.scrape));
  });

  /**
   * Attaches a release to an unmatched line by hand: the line leaves the list and the release joins
   * the scrape. A release the catalogue lacks is fetched from Discogs first, at inline priority and
   * with the collector's token; when Discogs has no such release nothing is stored or changed.
   */
  router.post("/:id/unmatched/:position/attach", async (req, res) => {
    const scrape = ownScrape(req.user!.uid, req.params.id);
    const position = Number(req.params.position);
    const line = scrape && Number.isInteger(position)
      ? db
          .select({ position: scrapeUnmatched.position })
          .from(scrapeUnmatched)
          .where(and(eq(scrapeUnmatched.scrapeId, scrape.id), eq(scrapeUnmatched.position, position)))
          .get()
      : undefined;
    if (!scrape || !line) {
      res.status(404).json({ error: "Unmatched line not found" });
      return;
    }
    const body = (req.body ?? {}) as Partial<Record<keyof AttachReleaseRequestDto, unknown>>;
    const releaseId = body.releaseId;
    if (typeof releaseId !== "number" || !Number.isInteger(releaseId) || releaseId < 1) {
      res.status(400).json({ error: "releaseId must be a positive integer" });
      return;
    }
    // A release flagged missing is hidden by Explore, so it is checked with Discogs again like an unknown one.
    if (!db.select({ id: releases.id }).from(releases).where(and(eq(releases.id, releaseId), isNotMissing)).get()) {
      const failure = await fetchReleaseFromDiscogs(deps, req.user!.uid, releaseId);
      if (failure) {
        res.status(failure.status).json(failure.body);
        return;
      }
    }
    db.transaction((tx) => {
      tx.insert(scrapeReleases).values({ scrapeId: scrape.id, releaseId }).onConflictDoNothing().run();
      tx.delete(scrapeUnmatched)
        .where(and(eq(scrapeUnmatched.scrapeId, scrape.id), eq(scrapeUnmatched.position, position)))
        .run();
    });
    res.json(toDto(scrape));
  });

  return router;
}
