import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { digitalMatches, digitalScans, releases, wantlistItems, type DigitalScanStatus } from "../db/schema";
import { MAX_CAP_RETRIES, PAUSE_CAP_MS, pauseStepMs } from "../queue/discogs-queue";
import { logger } from "../util/logger";
import { checkRelease, maxRequests, type CheckableRelease } from "./check-release";
import type { DigitalStores } from "./digital-stores";
import { saveDigitalMatch } from "./save-match";
import { StoreSessionExpiredError, StoreUnavailableError, type DigitalMatchStatus, type DigitalStoreId } from "./types";

export type DigitalScanRow = typeof digitalScans.$inferSelect;

/** A scan that has not ended: it is checking, waiting out a store error, or waiting for a fresh curl. */
const ACTIVE: DigitalScanStatus[] = ["running", "paused", "needs-session"];

export type StartScanResult = { scan: DigitalScanRow } | { conflict: "scan_active" } | { conflict: "session_required" };

/** Waits `ms`, or less when the signal aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * Scans of a collector's wantlist against a digital store (fader-ui#161). A scan walks the wantlist
 * items that have a release stored and checks them one after another through the store's lane, so a
 * check a person starts from a card overtakes it. The scan lives in this process; its row in
 * `digital_scans` carries the progress. Only the collector's latest scan per store is kept.
 *
 * - The store asks for a fresh curl (or the pasted one expired): the scan stops as `needs-session`
 *   with its progress, and `resume` carries on once a new curl is saved.
 * - The store errs (429, 5xx, no answer): the scan pauses and tries the same item again after the
 *   Discogs Pause steps (1, 2, 4, 8, then 10 minutes); about an hour of it ends the scan in error.
 * - An item that fails otherwise is counted as failed and the scan moves on.
 */
export class DigitalScanner {
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly db: Db,
    private readonly digital: DigitalStores,
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void> = wait,
    private readonly now: () => number = Date.now,
  ) {}

  /** The collector's active scan of the store, or else the last one. */
  current(uid: string, store: DigitalStoreId): DigitalScanRow | undefined {
    return this.db
      .select()
      .from(digitalScans)
      .where(and(eq(digitalScans.uid, uid), eq(digitalScans.store, store)))
      .get();
  }

  /** Starts a scan of the items with no match yet, or with `recheck` of every item, replacing the last scan. */
  start(uid: string, storeId: DigitalStoreId, recheck: boolean): StartScanResult {
    const previous = this.current(uid, storeId);
    if (previous && ACTIVE.includes(previous.status)) return { conflict: "scan_active" };
    if (!this.digital.sessions.get(uid, storeId)) return { conflict: "session_required" };

    const registered = this.digital.stores[storeId]!;
    const startedAt = new Date(Math.floor(this.now() / 1000) * 1000);
    const items = this.itemsToCheck(uid, storeId, { recheck, startedAt, failedReleaseIds: [] });
    const requestsPlanned = items.reduce((sum, item) => sum + maxRequests(registered.store, item), 0);

    this.db.transaction(() => {
      this.db
        .delete(digitalScans)
        .where(and(eq(digitalScans.uid, uid), eq(digitalScans.store, storeId)))
        .run();
      this.db
        .insert(digitalScans)
        .values({
          uid,
          store: storeId,
          recheck,
          status: items.length > 0 ? "running" : "done",
          total: items.length,
          skipped: this.unmatchedCount(uid),
          requestsPlanned,
          startedAt,
          finishedAt: items.length > 0 ? null : startedAt,
        })
        .run();
    });
    if (items.length > 0) void this.run(uid, storeId, items);
    return { scan: this.current(uid, storeId)! };
  }

  /** Carries on a scan that stopped for a fresh curl, once there is one. */
  resume(uid: string, storeId: DigitalStoreId): void {
    const scan = this.current(uid, storeId);
    if (!scan || scan.status !== "needs-session" || this.controllers.has(key(uid, storeId))) return;
    if (!this.digital.sessions.get(uid, storeId)) return;
    void this.run(uid, storeId, this.itemsToCheck(uid, storeId, scan));
  }

  /** Stops the active scan; the request in flight still finishes. */
  cancel(uid: string, storeId: DigitalStoreId): DigitalScanRow | undefined {
    const scan = this.current(uid, storeId);
    if (!scan || !ACTIVE.includes(scan.status)) return undefined;
    this.controllers.get(key(uid, storeId))?.abort();
    this.patch(uid, storeId, {
      status: "cancelled",
      currentReleaseId: null,
      pausedUntil: null,
      finishedAt: new Date(),
    });
    return this.current(uid, storeId);
  }

  /** The wantlist items with a release stored that the scan still has to check, oldest release first. */
  private itemsToCheck(
    uid: string,
    storeId: DigitalStoreId,
    scan: Pick<DigitalScanRow, "recheck" | "startedAt" | "failedReleaseIds">,
  ): CheckableRelease[] {
    const checkedAt = new Map(
      this.db
        .select({ releaseId: digitalMatches.releaseId, checkedAt: digitalMatches.checkedAt })
        .from(digitalMatches)
        .where(eq(digitalMatches.store, storeId))
        .all()
        .map((match) => [match.releaseId, match.checkedAt.getTime()]),
    );
    const failed = new Set(scan.failedReleaseIds);
    return this.db
      .select({ id: releases.id, title: releases.title, artists: releases.artists, tracklist: releases.tracklist })
      .from(wantlistItems)
      .innerJoin(releases, eq(releases.id, wantlistItems.releaseId))
      .where(eq(wantlistItems.uid, uid))
      .orderBy(releases.id)
      .all()
      .filter((release) => {
        if (failed.has(release.id)) return false;
        const at = checkedAt.get(release.id);
        return at === undefined || (scan.recheck && at < scan.startedAt.getTime());
      });
  }

  /** The wantlist items with no release stored yet, which a scan cannot check. */
  private unmatchedCount(uid: string): number {
    return this.db
      .select({ n: sql<number>`count(*)` })
      .from(wantlistItems)
      .leftJoin(releases, eq(releases.id, wantlistItems.releaseId))
      .where(and(eq(wantlistItems.uid, uid), sql`${releases.id} IS NULL`))
      .get()!.n;
  }

  private async run(uid: string, storeId: DigitalStoreId, items: CheckableRelease[]): Promise<void> {
    const controller = new AbortController();
    const { signal } = controller;
    this.controllers.set(key(uid, storeId), controller);
    const { store, lane } = this.digital.stores[storeId]!;
    let failures = 0;
    let capRetries = 0;

    try {
      this.patch(uid, storeId, { status: "running", pausedUntil: null, errorMessage: null });
      for (const release of items) {
        for (;;) {
          if (signal.aborted) return;
          const scan = this.current(uid, storeId)!;

          // A person's own check of the item may have got there first.
          const known = this.db
            .select()
            .from(digitalMatches)
            .where(and(eq(digitalMatches.releaseId, release.id), eq(digitalMatches.store, storeId)))
            .get();
          if (known && (!scan.recheck || known.checkedAt >= scan.startedAt)) {
            this.settle(uid, storeId, known.status, maxRequests(store, release), true);
            break;
          }

          const session = this.digital.sessions.get(uid, storeId);
          if (!session) return this.needsSession(uid, storeId);

          this.patch(uid, storeId, { currentReleaseId: release.id });
          try {
            const result = await checkRelease(store, lane, session, release, {
              signal,
              onRequest: () => this.bumpRequests(uid, storeId),
            });
            if (signal.aborted) return;
            saveDigitalMatch(this.db, release.id, storeId, result);
            this.settle(uid, storeId, result.status, maxRequests(store, release), false);
            failures = 0;
            capRetries = 0;
            break;
          } catch (err) {
            if (signal.aborted) return;
            if (err instanceof StoreSessionExpiredError) {
              this.digital.sessions.clear(uid, storeId);
              return this.needsSession(uid, storeId);
            }
            if (err instanceof StoreUnavailableError) {
              failures += 1;
              const stepMs = pauseStepMs(failures);
              if (stepMs === PAUSE_CAP_MS) capRetries += 1;
              if (capRetries > MAX_CAP_RETRIES) {
                logger.error(`Digital scan: ${storeId} still erroring after ${MAX_CAP_RETRIES} retries at the cap, giving up`);
                this.patch(uid, storeId, {
                  status: "failed",
                  errorMessage: `Gave up on the store: ${err.message}`,
                  currentReleaseId: null,
                  pausedUntil: null,
                  finishedAt: new Date(),
                });
                return;
              }
              logger.warn(`Digital scan: ${storeId} is erroring, pausing for ${stepMs}ms (failure ${failures} in a row): ${err.message}`);
              this.patch(uid, storeId, { status: "paused", pausedUntil: new Date(this.now() + stepMs) });
              await this.sleep(stepMs, signal);
              if (signal.aborted) return;
              this.patch(uid, storeId, { status: "running", pausedUntil: null });
              continue;
            }
            // The store answered, so the outage (if any) is over, but this item could not be checked.
            failures = 0;
            capRetries = 0;
            logger.error(`Digital scan: checking release ${release.id} against ${storeId} failed`, err);
            this.settleFailed(uid, storeId, release.id, maxRequests(store, release));
            break;
          }
        }
      }
      this.patch(uid, storeId, { status: "done", currentReleaseId: null, finishedAt: new Date() });
    } catch (err) {
      if (signal.aborted) return;
      logger.error("Digital scan failed", err);
      this.patch(uid, storeId, {
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
        currentReleaseId: null,
        pausedUntil: null,
        finishedAt: new Date(),
      });
    } finally {
      // A newer scan may own the key by now (cancel, then start): only forget our own.
      if (this.controllers.get(key(uid, storeId)) === controller) this.controllers.delete(key(uid, storeId));
    }
  }

  private needsSession(uid: string, storeId: DigitalStoreId): void {
    this.patch(uid, storeId, { status: "needs-session", currentReleaseId: null, pausedUntil: null });
  }

  /**
   * One more item is settled. An item a person had already checked cost the scan no requests, so
   * the requests it planned for it are dropped instead of counted as done.
   */
  private settle(uid: string, storeId: DigitalStoreId, status: DigitalMatchStatus, planned: number, alreadyKnown: boolean): void {
    const counts = {
      album: { albumCount: sql`${digitalScans.albumCount} + 1` },
      tracks: { tracksCount: sql`${digitalScans.tracksCount} + 1` },
      none: { noneCount: sql`${digitalScans.noneCount} + 1` },
    }[status];
    this.db
      .update(digitalScans)
      .set({
        ...counts,
        ...(alreadyKnown
          ? { requestsPlanned: sql`${digitalScans.requestsPlanned} - ${planned}` }
          : { plannedDone: sql`${digitalScans.plannedDone} + ${planned}` }),
        currentReleaseId: null,
      })
      .where(and(eq(digitalScans.uid, uid), eq(digitalScans.store, storeId)))
      .run();
  }

  private settleFailed(uid: string, storeId: DigitalStoreId, releaseId: number, planned: number): void {
    const scan = this.current(uid, storeId)!;
    this.patch(uid, storeId, {
      failedReleaseIds: [...scan.failedReleaseIds, releaseId],
      plannedDone: scan.plannedDone + planned,
      currentReleaseId: null,
    });
  }

  private bumpRequests(uid: string, storeId: DigitalStoreId): void {
    this.db
      .update(digitalScans)
      .set({ requestsDone: sql`${digitalScans.requestsDone} + 1` })
      .where(and(eq(digitalScans.uid, uid), eq(digitalScans.store, storeId)))
      .run();
  }

  private patch(uid: string, storeId: DigitalStoreId, set: Partial<DigitalScanRow>): void {
    this.db
      .update(digitalScans)
      .set(set)
      .where(and(eq(digitalScans.uid, uid), eq(digitalScans.store, storeId)))
      .run();
  }
}

function key(uid: string, storeId: DigitalStoreId): string {
  return `${uid}:${storeId}`;
}

/**
 * On startup: a scan the server stopped lost its curl with it (sessions are memory only), so it
 * waits for a fresh one, and resumes from where it was.
 */
export function settleScansAfterRestart(db: Db): void {
  db.update(digitalScans)
    .set({ status: "needs-session", currentReleaseId: null, pausedUntil: null })
    .where(inArray(digitalScans.status, ["running", "paused"]))
    .run();
}
