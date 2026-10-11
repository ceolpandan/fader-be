import { eq } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "../db/client";
import { discogsProfiles, discogsTokens } from "../db/schema";
import { DiscogsAuthError, DiscogsTransientError, getIdentity } from "../discogs-client";
import type { DiscogsTokenDto } from "../dto/discogs-token.dto";
import { encryptToken, tokenKeyAvailable } from "../util/token-crypto";
import { logger } from "../util/logger";

export interface DiscogsTokenRouterDeps {
  db: Db;
  getIdentity?: (token: string) => Promise<{ id: number; username: string }>;
}

const MAX_TOKEN_LENGTH = 200;

/**
 * The collector's Discogs personal access token, stored encrypted. It is write-only: `PUT` checks
 * it with Discogs and stores it, and nothing ever returns it, only whether one is set and the
 * Discogs username it belongs to.
 */
export function createDiscogsTokenRouter(deps: DiscogsTokenRouterDeps): Router {
  const router = Router();
  const identityOf = deps.getIdentity ?? getIdentity;

  router.get("/", (req, res) => {
    const row = deps.db
      .select({ username: discogsTokens.username })
      .from(discogsTokens)
      .where(eq(discogsTokens.uid, req.user!.uid))
      .get();
    const dto: DiscogsTokenDto = { set: !!row, username: row?.username ?? null };
    res.set("Cache-Control", "no-store").json(dto);
  });

  router.put("/", async (req, res) => {
    const body = (req.body ?? {}) as { token?: unknown };
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) {
      res.status(400).json({ error: "token must not be empty" });
      return;
    }
    if (token.length > MAX_TOKEN_LENGTH) {
      res.status(400).json({ error: `token must be at most ${MAX_TOKEN_LENGTH} characters` });
      return;
    }
    if (!tokenKeyAvailable()) {
      res.status(503).json({ error: "The server cannot store Discogs tokens: TOKEN_ENCRYPTION_KEY is not configured" });
      return;
    }

    let username: string;
    try {
      username = (await identityOf(token)).username;
    } catch (err) {
      if (err instanceof DiscogsAuthError) {
        res.status(400).json({ error: "Discogs did not accept this token" });
      } else if (err instanceof DiscogsTransientError) {
        res.status(502).json({ error: "Couldn't reach Discogs to check the token. Try again." });
      } else {
        logger.error("Discogs identity check failed", err);
        res.status(502).json({ error: "Couldn't check the token with Discogs. Try again." });
      }
      return;
    }

    const uid = req.user!.uid;
    // The cached profile belongs to the token it was fetched with.
    deps.db.delete(discogsProfiles).where(eq(discogsProfiles.uid, uid)).run();
    const values = { tokenEncrypted: encryptToken(token), username, createdAt: new Date() };
    deps.db
      .insert(discogsTokens)
      .values({ uid, ...values })
      .onConflictDoUpdate({ target: discogsTokens.uid, set: values })
      .run();

    const dto: DiscogsTokenDto = { set: true, username };
    res.json(dto);
  });

  router.delete("/", (req, res) => {
    deps.db.delete(discogsProfiles).where(eq(discogsProfiles.uid, req.user!.uid)).run();
    deps.db.delete(discogsTokens).where(eq(discogsTokens.uid, req.user!.uid)).run();
    res.status(204).end();
  });

  return router;
}
