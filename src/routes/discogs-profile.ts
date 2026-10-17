import { and, desc, eq, inArray } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "../db/client";
import { getDiscogsToken } from "../db/discogs-tokens";
import { discogsProfiles, discogsQueueJobs, discogsTokens } from "../db/schema";
import { DiscogsAuthError } from "../discogs-client";
import type { DiscogsProfileDto, DiscogsSyncDto } from "../dto/discogs-profile.dto";
import { syncRunId } from "../indexing/discogs-sync-handler";
import type { DiscogsQueue } from "../queue/discogs-queue";
import {
  NonRetryableError,
  QueueUnavailableError,
  QueueWaitTimeoutError,
  SYNC_PRIORITY,
} from "../queue/discogs-queue";
import { logger } from "../util/logger";

export interface DiscogsProfileRouterDeps {
  db: Db;
  queue: DiscogsQueue;
}

/** What the collector can act on, from the error a failed sync job kept. */
function syncErrorMessage(errorMessage: string | null): string {
  if (errorMessage?.startsWith("Discogs refused our token")) {
    return "Discogs did not accept your token. Update it in Settings.";
  }
  if (errorMessage?.startsWith("No Discogs token")) return "Save a Discogs token in Settings first";
  if (errorMessage?.startsWith("Gave up on Discogs")) {
    return "Discogs is unavailable right now. Try again later.";
  }
  return "Couldn't sync your Discogs lists. Try again.";
}

/**
 * Where the collector's sync stands, from the latest job of their sync run: queued or running
 * (a paused lane counts, it is retrying), failed, or nothing to report. A failure from before the
 * current token was saved is not reported: the collector has since fixed what they could.
 */
function syncState(db: Db, uid: string): DiscogsSyncDto {
  const job = db
    .select({
      status: discogsQueueJobs.status,
      errorMessage: discogsQueueJobs.errorMessage,
      createdAt: discogsQueueJobs.createdAt,
    })
    .from(discogsQueueJobs)
    .where(eq(discogsQueueJobs.runId, syncRunId(uid)))
    .orderBy(desc(discogsQueueJobs.id))
    .limit(1)
    .get();
  if (!job || job.status === "done") return { status: "idle", error: null };
  if (job.status !== "failed") return { status: "running", error: null };

  const tokenSavedAt = db
    .select({ createdAt: discogsTokens.createdAt })
    .from(discogsTokens)
    .where(eq(discogsTokens.uid, uid))
    .get()?.createdAt;
  if (tokenSavedAt && job.createdAt < tokenSavedAt) return { status: "idle", error: null };
  return { status: "failed", error: syncErrorMessage(job.errorMessage) };
}

function cached(db: Db, uid: string): DiscogsProfileDto {
  const row = db.select().from(discogsProfiles).where(eq(discogsProfiles.uid, uid)).get();
  return {
    tokenSet: getDiscogsToken(db, uid) !== null,
    profile: row
      ? {
          username: row.username,
          collectionCount: row.collectionCount,
          wantlistCount: row.wantlistCount,
          fetchedAt: row.fetchedAt.toISOString(),
          lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
        }
      : null,
    sync: syncState(db, uid),
  };
}

/**
 * The collector's Discogs profile for the home page: the cached copy, a counts fetch for the first
 * visit, and the sync of their collection and wantlist. Everything goes through the Discogs queue
 * like every other request, so it stays within the rate limit. Nothing is fetched until the
 * collector asks.
 */
export function createDiscogsProfileRouter(deps: DiscogsProfileRouterDeps): Router {
  const router = Router();

  router.get("/", (req, res) => {
    res.set("Cache-Control", "no-store").json(cached(deps.db, req.user!.uid));
  });

  // The collection and wantlist counts without a sync: they fill the home card, and the first
  // sync's confirmation, before anything has been hidden. Inline work, ahead of any job.
  router.post("/counts", async (req, res) => {
    const uid = req.user!.uid;
    if (!getDiscogsToken(deps.db, uid)) {
      res.status(409).json({ error: "Save a Discogs token in Settings first" });
      return;
    }

    try {
      await deps.queue.enqueueAndWait({
        runId: `discogs-profile:${uid}`,
        type: "discogs_profile",
        payload: { uid },
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
        res.status(504).json({ error: "Discogs is busy. Your profile will update once it catches up." });
      } else {
        logger.error("Discogs profile fetch failed", err);
        res.status(502).json({ error: "Couldn't fetch your Discogs profile. Try again." });
      }
      return;
    }
    res.set("Cache-Control", "no-store").json(cached(deps.db, uid));
  });

  // Starts the sync and answers at once (202): it takes minutes, so the UI reads `sync` from GET
  // until it is idle again. A sync already queued or running is not started twice.
  router.post("/refresh", (req, res) => {
    const uid = req.user!.uid;
    if (!getDiscogsToken(deps.db, uid)) {
      res.status(409).json({ error: "Save a Discogs token in Settings first" });
      return;
    }

    const runId = syncRunId(uid);
    const active = deps.db
      .select({ id: discogsQueueJobs.id })
      .from(discogsQueueJobs)
      .where(and(eq(discogsQueueJobs.runId, runId), inArray(discogsQueueJobs.status, ["pending", "processing"])))
      .limit(1)
      .get();
    if (!active) {
      deps.queue.enqueue({ runId, type: "discogs_sync", payload: { uid }, priority: SYNC_PRIORITY });
    }
    res.status(202).set("Cache-Control", "no-store").json(cached(deps.db, uid));
  });

  return router;
}
