import { and, asc, count, eq } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "../db/client";
import { isNotMissing } from "../db/missing";
import { releases, scrapeReleases, scrapes, scrapeUnmatched } from "../db/schema";
import type {
  AttachReleaseRequestDto,
  CreateScrapeRequestDto,
  RenameScrapeRequestDto,
  ScrapeDto,
  ScrapeUnmatchedDto,
} from "../dto/scrape.dto";
import type { DiscogsQueue } from "../queue/discogs-queue";
import { matchScrapeLines } from "../scrapes/match-scrape";
import { parseLines } from "../scrapes/normalise";
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

  const toDto = (row: typeof scrapes.$inferSelect): ScrapeDto => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    releaseCount: countOf(scrapeReleases, row.id),
    unmatchedCount: countOf(scrapeUnmatched, row.id),
  });

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
    db.transaction((tx) => {
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
    const lines = db
      .select({ position: scrapeUnmatched.position, line: scrapeUnmatched.line })
      .from(scrapeUnmatched)
      .where(eq(scrapeUnmatched.scrapeId, scrape.id))
      .orderBy(asc(scrapeUnmatched.position))
      .all();
    const dto: ScrapeUnmatchedDto = { lines };
    res.set("Cache-Control", "no-store").json(dto);
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
