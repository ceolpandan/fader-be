import { eq } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "../db/client";
import { getDiscogsToken } from "../db/discogs-tokens";
import { discogsProfiles } from "../db/schema";
import { DiscogsAuthError } from "../discogs-client";
import type { DiscogsProfileDto } from "../dto/discogs-profile.dto";
import type { DiscogsQueue } from "../queue/discogs-queue";
import { NonRetryableError, QueueUnavailableError, QueueWaitTimeoutError } from "../queue/discogs-queue";
import { logger } from "../util/logger";

export interface DiscogsProfileRouterDeps {
  db: Db;
  queue: DiscogsQueue;
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
        }
      : null,
  };
}

/**
 * The collector's Discogs profile for the home page: the cached copy, and a refresh that fetches
 * it again with their saved token. The refresh goes through the Discogs queue like every other
 * request, ahead of any enrichment run, so it stays within the rate limit. Nothing is fetched
 * until the collector asks.
 */
export function createDiscogsProfileRouter(deps: DiscogsProfileRouterDeps): Router {
  const router = Router();

  router.get("/", (req, res) => {
    res.set("Cache-Control", "no-store").json(cached(deps.db, req.user!.uid));
  });

  router.post("/refresh", async (req, res) => {
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

  return router;
}
