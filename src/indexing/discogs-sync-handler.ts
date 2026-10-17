import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  collectionItems,
  discogsProfiles,
  discogsQueueJobs,
  discogsTokens,
  fades,
  hiddenReleases,
  releases,
  wantlistItems,
  type DiscogsSyncPayload,
  type ReleaseArtistStub,
} from "../db/schema";
import type { DiscogsCollectionResponse, DiscogsListItem, DiscogsWantlistResponse } from "../types/discogs-api";
import { AVAILABILITY_PRIORITY, NonRetryableError, PACING_MS, SYNC_PRIORITY, type EnqueueInput, type JobHandler } from "../queue/discogs-queue";
import { logger } from "../util/logger";
import { enqueueFadeLookup, hasStoredVersions } from "./fade-lookup-handler";

export interface DiscogsSyncHandlerDeps {
  db: Db;
  enqueue: (job: EnqueueInput) => number;
  /** The collector's Discogs token, or null when they have none (the job then fails). */
  getToken: (uid: string) => string | null;
  getWantlistPage: (username: string, page: number, token: string) => Promise<DiscogsWantlistResponse>;
  getCollectionPage: (username: string, page: number, token: string) => Promise<DiscogsCollectionResponse>;
  /** Waits between Discogs requests; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** Queue run id of a collector's sync, kept apart from every other run. One sync at a time per collector. */
export function syncRunId(uid: string): string {
  return `discogs-sync:${uid}`;
}

interface ListEntry {
  releaseId: number;
  /** Null for a release without a master (Discogs sends `0`). */
  masterId: number | null;
  title: string;
  artists: ReleaseArtistStub[];
  addedAt: Date | null;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function toEntry(item: DiscogsListItem): ListEntry {
  const info = item.basic_information;
  const addedAt = item.date_added ? new Date(item.date_added) : null;
  return {
    releaseId: item.id,
    masterId: info.master_id || null,
    title: info.title,
    artists: (info.artists ?? []).map((artist) => ({ id: artist.id, name: artist.name })),
    addedAt: addedAt && !Number.isNaN(addedAt.getTime()) ? addedAt : null,
  };
}

/** One entry per release: a collection holds a release once per copy, but the mirror keeps one row. */
function uniqueByRelease(items: DiscogsListItem[]): ListEntry[] {
  const entries = new Map<number, ListEntry>();
  for (const item of items) {
    if (!entries.has(item.id)) entries.set(item.id, toEntry(item));
  }
  return [...entries.values()];
}

/** Queue label of a collector's wantlist availability fetches: no `enrichment_runs` row, so a saved-filter run never touches them. */
export function wantlistAvailabilityRunId(uid: string): string {
  return `wantlist-availability:${uid}`;
}

/** A release's availability is fresh for this long; the threshold is on the shared column, so another collector's fetch counts. */
export const AVAILABILITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Once the sync has committed, queues a `release_detail` job (priority 1, behind the sync's own
 * priority-5 work) for each wantlist release that is not stored, was never enriched or has an
 * availability older than a day (fader-ui#143). A release another job already has queued is left to
 * that job, and one Discogs no longer has (`missing_at`) is not asked for again.
 */
export function queueWantlistEnrichment(
  db: Db,
  enqueue: (job: EnqueueInput) => number,
  uid: string,
  wantlistReleaseIds: number[],
  now = new Date(),
): number {
  if (wantlistReleaseIds.length === 0) return 0;
  const staleBefore = new Date(now.getTime() - AVAILABILITY_MAX_AGE_MS);
  const queued = new Set(
    db
      .select({ payload: discogsQueueJobs.payload })
      .from(discogsQueueJobs)
      .where(and(eq(discogsQueueJobs.type, "release_detail"), inArray(discogsQueueJobs.status, ["pending", "processing"])))
      .all()
      .map((job) => (job.payload as { releaseId: number }).releaseId),
  );
  const stored = new Map<number, { enrichedAt: Date | null; numForSaleAt: Date | null; missingAt: Date | null }>();
  // Chunked to stay under SQLite's bound-variable limit on a long wantlist.
  for (let i = 0; i < wantlistReleaseIds.length; i += 500) {
    const rows = db
      .select({ id: releases.id, enrichedAt: releases.enrichedAt, numForSaleAt: releases.numForSaleAt, missingAt: releases.missingAt })
      .from(releases)
      .where(inArray(releases.id, wantlistReleaseIds.slice(i, i + 500)))
      .all();
    for (const row of rows) stored.set(row.id, row);
  }

  let count = 0;
  for (const releaseId of wantlistReleaseIds) {
    if (queued.has(releaseId)) continue;
    const row = stored.get(releaseId);
    if (row?.missingAt) continue;
    const fresh = row && row.enrichedAt && row.numForSaleAt && row.numForSaleAt >= staleBefore;
    if (fresh) continue;
    enqueue({ runId: wantlistAvailabilityRunId(uid), type: "release_detail", payload: { uid, releaseId }, priority: AVAILABILITY_PRIORITY });
    count += 1;
  }
  return count;
}

/**
 * Syncs the collector's Discogs wantlist and collection (fader-ui#116). It pages the wantlist and
 * then the collection with the collector's token, spaced like the queue spaces jobs, and writes
 * nothing until every page is in: a Discogs error part-way (the queue pauses, then runs the job
 * again from the start) or a failure leaves the previous mirror as it was. Then, in one transaction:
 *
 * - the two lists are mirrored (new items added, departed items deleted);
 * - every release now on either list is hidden and loses its release fade; when it has a master the
 *   collector has not faded, the master is faded and its lookup queued, which fades every other
 *   version of it;
 * - a release that left both lists loses its hidden row. The master fade the sync wrote stays, and
 *   a fade the collector made themselves is never touched.
 *
 * The profile counts are then those of the mirrored lists, and `last_synced_at` is set.
 */
export function createDiscogsSyncHandler(deps: DiscogsSyncHandlerDeps): JobHandler<DiscogsSyncPayload> {
  const sleep = deps.sleep ?? wait;

  /** Every page of a listing, `PACING_MS` apart. */
  async function fetchPages(
    fetchPage: (page: number) => Promise<{ pages: number; items: DiscogsListItem[] }>,
  ): Promise<DiscogsListItem[]> {
    const items: DiscogsListItem[] = [];
    let page = 1;
    let pages = 1;
    do {
      const res = await fetchPage(page);
      items.push(...res.items);
      pages = res.pages;
      page += 1;
      if (page <= pages) await sleep(PACING_MS);
    } while (page <= pages);
    return items;
  }

  return async ({ uid }) => {
    const token = deps.getToken(uid);
    const username = deps.db
      .select({ username: discogsTokens.username })
      .from(discogsTokens)
      .where(eq(discogsTokens.uid, uid))
      .get()?.username;
    if (!token || !username) throw new NonRetryableError("No Discogs token saved");

    const wanted = uniqueByRelease(
      await fetchPages(async (page) => {
        const res = await deps.getWantlistPage(username, page, token);
        return { pages: res.pagination.pages, items: res.wants };
      }),
    );
    await sleep(PACING_MS);
    const owned = uniqueByRelease(
      await fetchPages(async (page) => {
        const res = await deps.getCollectionPage(username, page, token);
        return { pages: res.pagination.pages, items: res.releases };
      }),
    );

    const now = new Date();
    const lookups: number[] = [];

    deps.db.transaction(() => {
      const before = new Set([
        ...deps.db.select({ id: wantlistItems.releaseId }).from(wantlistItems).where(eq(wantlistItems.uid, uid)).all().map((row) => row.id),
        ...deps.db.select({ id: collectionItems.releaseId }).from(collectionItems).where(eq(collectionItems.uid, uid)).all().map((row) => row.id),
      ]);

      deps.db.delete(wantlistItems).where(eq(wantlistItems.uid, uid)).run();
      deps.db.delete(collectionItems).where(eq(collectionItems.uid, uid)).run();
      for (const entry of wanted) {
        deps.db.insert(wantlistItems).values({ uid, ...entry }).run();
      }
      for (const { releaseId, masterId, title, artists } of owned) {
        deps.db.insert(collectionItems).values({ uid, releaseId, masterId, title, artists }).run();
      }

      const hiddenNow = new Map<number, ListEntry>();
      for (const entry of [...wanted, ...owned]) {
        if (!hiddenNow.has(entry.releaseId)) hiddenNow.set(entry.releaseId, entry);
      }

      for (const releaseId of before) {
        if (hiddenNow.has(releaseId)) continue;
        deps.db
          .delete(hiddenReleases)
          .where(and(eq(hiddenReleases.uid, uid), eq(hiddenReleases.releaseId, releaseId)))
          .run();
      }

      const masters = new Map<number, ListEntry>();
      for (const entry of hiddenNow.values()) {
        deps.db.insert(hiddenReleases).values({ uid, releaseId: entry.releaseId }).onConflictDoNothing().run();
        deps.db
          .delete(fades)
          .where(and(eq(fades.uid, uid), eq(fades.kind, "release"), eq(fades.id, entry.releaseId)))
          .run();
        if (entry.masterId !== null && !masters.has(entry.masterId)) masters.set(entry.masterId, entry);
      }

      for (const [masterId, entry] of masters) {
        const existing = deps.db
          .select({ id: fades.id })
          .from(fades)
          .where(and(eq(fades.uid, uid), eq(fades.kind, "master"), eq(fades.id, masterId)))
          .get();
        if (existing) continue;

        const needsLookup = !hasStoredVersions(deps.db, masterId);
        deps.db
          .insert(fades)
          .values({
            uid,
            kind: "master",
            id: masterId,
            createdAt: now,
            lookupStatus: needsLookup ? "pending" : "done",
            title: entry.title,
            artists: entry.artists,
          })
          .run();
        if (needsLookup) lookups.push(masterId);
      }

      // Queued in the same transaction, so a master fade never waits for a lookup nobody queued.
      for (const masterId of lookups) {
        enqueueFadeLookup(deps.enqueue, uid, "master", masterId, SYNC_PRIORITY);
      }

      const values = {
        username,
        collectionCount: owned.length,
        wantlistCount: wanted.length,
        fetchedAt: now,
        lastSyncedAt: now,
      };
      deps.db
        .insert(discogsProfiles)
        .values({ uid, ...values })
        .onConflictDoUpdate({ target: discogsProfiles.uid, set: values })
        .run();
    });

    logger.info(`Synced ${uid}: ${wanted.length} wanted, ${owned.length} owned, ${lookups.length} master fades to look up`);
    const availability = queueWantlistEnrichment(
      deps.db,
      deps.enqueue,
      uid,
      wanted.map((entry) => entry.releaseId),
    );
    if (availability > 0) logger.info(`Queued ${availability} wantlist availability fetches for ${uid}`);
  };
}
