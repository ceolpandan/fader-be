import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { isNotMissing } from "../db/missing";
import {
  discogsQueueJobs,
  releases,
  scrapeReleases,
  scrapes,
  scrapeSearchMatches,
  scrapeUnmatched,
  type ScrapeSearchPayload,
} from "../db/schema";
import { NonRetryableError, SEARCH_PRIORITY, type DiscogsQueue, type JobHandler } from "../queue/discogs-queue";
import { logger } from "../util/logger";
import { sanitiseSearchQuery } from "./sanitise";

const RUN_PREFIX = "scrape-search:";

/** The queue run all of a scrape's search jobs (and the release fetches they need) belong to. */
export const scrapeSearchRunId = (scrapeId: number): string => `${RUN_PREFIX}${scrapeId}`;

function scrapeIdOf(runId: string): number | null {
  if (!runId.startsWith(RUN_PREFIX)) return null;
  const id = Number(runId.slice(RUN_PREFIX.length));
  return Number.isInteger(id) ? id : null;
}

const matchOf = (scrapeId: number, position: number) =>
  and(eq(scrapeSearchMatches.scrapeId, scrapeId), eq(scrapeSearchMatches.position, position));

/** Links a matched line to its release: the release joins the scrape and the line leaves the unmatched list. */
export function linkSearchMatch(db: Db, scrapeId: number, position: number, releaseId: number): void {
  db.transaction((tx) => {
    const existing = tx
      .select({ releaseId: scrapeReleases.releaseId })
      .from(scrapeReleases)
      .where(and(eq(scrapeReleases.scrapeId, scrapeId), eq(scrapeReleases.releaseId, releaseId)))
      .get();
    if (!existing) tx.insert(scrapeReleases).values({ scrapeId, releaseId }).run();
    tx.delete(scrapeUnmatched)
      .where(and(eq(scrapeUnmatched.scrapeId, scrapeId), eq(scrapeUnmatched.position, position)))
      .run();
    tx.update(scrapeSearchMatches)
      .set({ status: "matched", releaseId, addedRelease: !existing })
      .where(matchOf(scrapeId, position))
      .run();
  });
}

/**
 * Queues a Discogs search for each of the given unmatched lines of a scrape. Lines already queued,
 * being fetched, matched or rejected are left alone; a line that found nothing or failed is
 * searched again. Returns how many searches were queued.
 */
export function queueScrapeSearches(
  db: Db,
  queue: DiscogsQueue,
  uid: string,
  scrapeId: number,
  lines: { position: number; line: string }[],
): number {
  let queued = 0;
  for (const { position, line } of lines) {
    const current = db
      .select({ status: scrapeSearchMatches.status })
      .from(scrapeSearchMatches)
      .where(matchOf(scrapeId, position))
      .get();
    if (current && current.status !== "no_result" && current.status !== "failed") continue;

    const query = sanitiseSearchQuery(line);
    if (!query) continue;
    db.insert(scrapeSearchMatches)
      .values({ scrapeId, position, line, query, status: "queued" })
      .onConflictDoUpdate({
        target: [scrapeSearchMatches.scrapeId, scrapeSearchMatches.position],
        set: { query, status: "queued", releaseId: null },
      })
      .run();
    queue.enqueue({
      runId: scrapeSearchRunId(scrapeId),
      type: "scrape_search",
      payload: { uid, scrapeId, position } satisfies ScrapeSearchPayload,
      priority: SEARCH_PRIORITY,
    });
    queued += 1;
  }
  return queued;
}

export interface ScrapeSearchHandlerDeps {
  db: Db;
  queue: DiscogsQueue;
  /** The collector's Discogs token, or null when they have none (the job then fails). */
  getToken: (uid: string) => string | null;
  searchFirstReleaseId: (query: string, token: string) => Promise<number | null>;
}

/**
 * Searches Discogs for one unmatched line and takes the first release it returns. A release the
 * catalogue has links at once; any other is fetched by a `release_detail` job in the same run, and
 * the line links when that job is done (`settleScrapeSearch`). The same query searched before for
 * this collector reuses the earlier answer instead of asking Discogs again.
 */
export function createScrapeSearchHandler(deps: ScrapeSearchHandlerDeps): JobHandler<ScrapeSearchPayload> {
  const { db } = deps;
  return async ({ uid, scrapeId, position }) => {
    const match = db.select().from(scrapeSearchMatches).where(matchOf(scrapeId, position)).get();
    // The scrape was deleted, or the line settled some other way, since the job was queued.
    if (!match || match.status !== "queued") return;

    const token = deps.getToken(uid);
    if (!token) throw new NonRetryableError("No Discogs token saved");

    const earlier = db
      .select({ releaseId: scrapeSearchMatches.releaseId })
      .from(scrapeSearchMatches)
      .innerJoin(scrapes, eq(scrapes.id, scrapeSearchMatches.scrapeId))
      .where(
        and(
          eq(scrapes.uid, uid),
          eq(scrapeSearchMatches.query, match.query),
          eq(scrapeSearchMatches.status, "matched"),
        ),
      )
      .get();
    const releaseId = earlier?.releaseId ?? (await deps.searchFirstReleaseId(match.query, token));
    logger.info(`Scrape ${scrapeId} line ${position} "${match.query}" -> ${releaseId ?? "no result"}`);

    if (releaseId === null) {
      db.update(scrapeSearchMatches).set({ status: "no_result" }).where(matchOf(scrapeId, position)).run();
      return;
    }

    const inCatalogue = db
      .select({ id: releases.id })
      .from(releases)
      .where(and(eq(releases.id, releaseId), isNotMissing))
      .get();
    if (inCatalogue) {
      linkSearchMatch(db, scrapeId, position, releaseId);
      return;
    }

    db.update(scrapeSearchMatches).set({ status: "fetching", releaseId }).where(matchOf(scrapeId, position)).run();
    const runId = scrapeSearchRunId(scrapeId);
    const alreadyQueued = db
      .select({ id: discogsQueueJobs.id })
      .from(discogsQueueJobs)
      .where(
        and(
          eq(discogsQueueJobs.runId, runId),
          eq(discogsQueueJobs.type, "release_detail"),
          inArray(discogsQueueJobs.status, ["pending", "processing"]),
          sql`json_extract(${discogsQueueJobs.payload}, '$.releaseId') = ${releaseId}`,
        ),
      )
      .get();
    if (!alreadyQueued) {
      deps.queue.enqueue({ runId, type: "release_detail", payload: { uid, releaseId }, priority: SEARCH_PRIORITY });
    }
  };
}

/**
 * Queue listener: a search job that failed for good leaves its line `failed`; a release fetched
 * for the searches links its lines when done, and fails them when it could not be fetched.
 */
export function settleScrapeSearch(
  db: Db,
  job: { type: string; runId: string; status: string; payload: unknown },
): void {
  const scrapeId = scrapeIdOf(job.runId);
  if (scrapeId === null) return;

  if (job.type === "scrape_search" && job.status === "failed") {
    const { position } = job.payload as ScrapeSearchPayload;
    db.update(scrapeSearchMatches)
      .set({ status: "failed" })
      .where(and(matchOf(scrapeId, position), eq(scrapeSearchMatches.status, "queued")))
      .run();
    return;
  }

  if (job.type !== "release_detail") return;
  const { releaseId } = job.payload as { releaseId: number };
  const waiting = db
    .select({ position: scrapeSearchMatches.position })
    .from(scrapeSearchMatches)
    .where(
      and(
        eq(scrapeSearchMatches.scrapeId, scrapeId),
        eq(scrapeSearchMatches.status, "fetching"),
        eq(scrapeSearchMatches.releaseId, releaseId),
      ),
    )
    .all();
  for (const { position } of waiting) {
    if (job.status === "done") linkSearchMatch(db, scrapeId, position, releaseId);
    else db.update(scrapeSearchMatches).set({ status: "failed" }).where(matchOf(scrapeId, position)).run();
  }
}

/** Queue listener: Discogs gave up on (or refused the token of) a scrape's searches, so its unfinished lines are `failed`. */
export function failScrapeSearches(db: Db, runId: string): void {
  const scrapeId = scrapeIdOf(runId);
  if (scrapeId === null) return;
  db.update(scrapeSearchMatches)
    .set({ status: "failed" })
    .where(and(eq(scrapeSearchMatches.scrapeId, scrapeId), inArray(scrapeSearchMatches.status, ["queued", "fetching"])))
    .run();
}

/**
 * Takes a line's search match back: it returns to the unmatched list as `rejected` (not searched
 * again), and the release leaves the scrape when this match was what put it there and no other
 * searched line still holds it.
 */
export function unlinkSearchMatch(db: Db, scrapeId: number, position: number): void {
  db.transaction((tx) => {
    const match = tx.select().from(scrapeSearchMatches).where(matchOf(scrapeId, position)).get();
    if (!match || match.status !== "matched" || match.releaseId === null) return;

    tx.update(scrapeSearchMatches)
      .set({ status: "rejected", committed: false, addedRelease: false })
      .where(matchOf(scrapeId, position))
      .run();
    tx.insert(scrapeUnmatched).values({ scrapeId, position, line: match.line }).onConflictDoNothing().run();

    if (!match.addedRelease) return;
    const heir = tx
      .select({ position: scrapeSearchMatches.position })
      .from(scrapeSearchMatches)
      .where(
        and(
          eq(scrapeSearchMatches.scrapeId, scrapeId),
          eq(scrapeSearchMatches.status, "matched"),
          eq(scrapeSearchMatches.releaseId, match.releaseId),
        ),
      )
      .get();
    if (heir) {
      tx.update(scrapeSearchMatches).set({ addedRelease: true }).where(matchOf(scrapeId, heir.position)).run();
    } else {
      tx.delete(scrapeReleases)
        .where(and(eq(scrapeReleases.scrapeId, scrapeId), eq(scrapeReleases.releaseId, match.releaseId)))
        .run();
    }
  });
}
