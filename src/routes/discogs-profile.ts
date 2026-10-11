import { eq } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "../db/client";
import { getDiscogsToken } from "../db/discogs-tokens";
import { discogsProfiles } from "../db/schema";
import { DiscogsAuthError, DiscogsTransientError, getDiscogsProfile, type DiscogsProfile } from "../discogs-client";
import type { DiscogsProfileDto } from "../dto/discogs-profile.dto";
import { logger } from "../util/logger";

export interface DiscogsProfileRouterDeps {
  db: Db;
  /** Fetches the token owner's profile from Discogs; defaults to the real API. */
  getDiscogsProfile?: (token: string) => Promise<DiscogsProfile>;
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
 * it again with their saved token. Nothing is fetched until the collector asks.
 */
export function createDiscogsProfileRouter(deps: DiscogsProfileRouterDeps): Router {
  const router = Router();
  const fetchProfile = deps.getDiscogsProfile ?? getDiscogsProfile;

  router.get("/", (req, res) => {
    res.set("Cache-Control", "no-store").json(cached(deps.db, req.user!.uid));
  });

  router.post("/refresh", async (req, res) => {
    const uid = req.user!.uid;
    const token = getDiscogsToken(deps.db, uid);
    if (!token) {
      res.status(409).json({ error: "Save a Discogs token in Settings first" });
      return;
    }

    let profile: DiscogsProfile;
    try {
      profile = await fetchProfile(token);
    } catch (err) {
      // 400, not 401: the UI treats a 401 from this API as a lost sign-in.
      if (err instanceof DiscogsAuthError) {
        res.status(400).json({ error: "Discogs did not accept your token. Update it in Settings." });
      } else if (err instanceof DiscogsTransientError) {
        res.status(502).json({ error: "Couldn't reach Discogs. Try again in a moment." });
      } else {
        logger.error("Discogs profile fetch failed", err);
        res.status(502).json({ error: "Couldn't fetch your Discogs profile. Try again." });
      }
      return;
    }

    const values = { ...profile, fetchedAt: new Date() };
    deps.db
      .insert(discogsProfiles)
      .values({ uid, ...values })
      .onConflictDoUpdate({ target: discogsProfiles.uid, set: values })
      .run();
    res.set("Cache-Control", "no-store").json(cached(deps.db, uid));
  });

  return router;
}
