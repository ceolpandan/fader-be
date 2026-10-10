import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  fades,
  masterVersions,
  type FadeKind,
  type FadeLookupPayload,
  type QueueJobStatus,
} from "../db/schema";
import { DiscogsNotFoundError } from "../discogs-client";
import {
  INLINE_PRIORITY,
  NonRetryableError,
  type EnqueueInput,
  type JobHandler,
} from "../queue/discogs-queue";
import type { DiscogsRelease } from "../types/discogs-api";

export interface FadeLookupHandlerDeps {
  db: Db;
  enqueue: (job: EnqueueInput) => number;
  getRelease: (releaseId: number) => Promise<DiscogsRelease>;
  getMasterVersionReleaseIds: (masterId: number) => Promise<number[]>;
}

/** Queue run id of a fade's lookup, kept apart from every seller's indexing run. */
export function fadeLookupRunId(uid: string, id: number): string {
  return `fade:${uid}:${id}`;
}

/** Queues a lookup for `uid`'s fade; user-driven, so it runs ahead of scans and enrichment. */
export function enqueueFadeLookup(
  enqueue: (job: EnqueueInput) => number,
  uid: string,
  kind: FadeKind,
  id: number,
): void {
  const payload: FadeLookupPayload = { uid, kind, id };
  enqueue({
    runId: fadeLookupRunId(uid, id),
    type: "fade_lookup",
    payload,
    priority: INLINE_PRIORITY,
  });
}

/**
 * Resolves a fade against Discogs. A release fade looks up the release's master and upgrades to
 * it (a release without a master stays as it is); a master fade stores the master's versions,
 * unless another collector's lookup already did. A Discogs 404 is permanent and surfaces as a
 * NonRetryableError, which `markFadeLookupFailed` turns into `failed`.
 */
export function createFadeLookupHandler(
  deps: FadeLookupHandlerDeps,
): JobHandler<FadeLookupPayload> {
  const fadeRow = (uid: string, kind: FadeKind, id: number) =>
    and(eq(fades.uid, uid), eq(fades.kind, kind), eq(fades.id, id));

  return async ({ uid, kind, id }) => {
    const [fade] = deps.db
      .select()
      .from(fades)
      .where(fadeRow(uid, kind, id))
      .all();
    if (!fade) return; // Unfaded while the lookup waited.

    if (kind === "release") {
      let release: DiscogsRelease;
      try {
        release = await deps.getRelease(id);
      } catch (err) {
        if (err instanceof DiscogsNotFoundError)
          throw new NonRetryableError(err.message);
        throw err;
      }

      const masterId = release.master_id || null;
      if (!masterId) {
        deps.db
          .update(fades)
          .set({ lookupStatus: "done" })
          .where(fadeRow(uid, kind, id))
          .run();
        return;
      }

      deps.db.transaction(() => {
        deps.db
          .delete(fades)
          .where(fadeRow(uid, kind, id))
          .run();
        deps.db
          .insert(fades)
          .values({
            uid,
            kind: "master",
            id: masterId,
            createdAt: fade.createdAt,
            lookupStatus: "pending",
          })
          .onConflictDoNothing()
          .run();
      });
      enqueueFadeLookup(deps.enqueue, uid, "master", masterId);
      return;
    }

    if (!hasStoredVersions(deps.db, id)) {
      let versionIds: number[];
      try {
        versionIds = await deps.getMasterVersionReleaseIds(id);
      } catch (err) {
        if (err instanceof DiscogsNotFoundError)
          throw new NonRetryableError(err.message);
        throw err;
      }
      deps.db.transaction(() => {
        for (const releaseId of new Set(versionIds)) {
          deps.db
            .insert(masterVersions)
            .values({ masterId: id, releaseId })
            .onConflictDoNothing()
            .run();
        }
      });
    }
    markMasterFadesDone(deps.db, id);
  };
}

export function hasStoredVersions(db: Db, masterId: number): boolean {
  return (
    db
      .select()
      .from(masterVersions)
      .where(eq(masterVersions.masterId, masterId))
      .limit(1)
      .all().length > 0
  );
}

/** The versions are known, so every collector's pending fade of this master is resolved. */
export function markMasterFadesDone(db: Db, masterId: number): void {
  db.update(fades)
    .set({ lookupStatus: "done" })
    .where(
      and(
        eq(fades.kind, "master"),
        eq(fades.id, masterId),
        eq(fades.lookupStatus, "pending"),
      ),
    )
    .run();
}

/** Settled-job listener: a lookup that ended `failed` leaves its fade in place, marked `failed`. */
export function markFadeLookupFailed(
  db: Db,
  job: { type: string; status: QueueJobStatus; payload: unknown },
): void {
  if (job.type !== "fade_lookup" || job.status !== "failed") return;
  const { uid, kind, id } = job.payload as FadeLookupPayload;
  db.update(fades)
    .set({ lookupStatus: "failed" })
    .where(
      and(
        eq(fades.uid, uid),
        eq(fades.kind, kind),
        eq(fades.id, id),
        eq(fades.lookupStatus, "pending"),
      ),
    )
    .run();
}
