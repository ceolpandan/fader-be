import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { discogsTokens, enrichmentNotFound, enrichmentRuns, releaseRaw, releases } from "../db/schema";
import type { ReleaseDetailPayload } from "../db/schema";
import { DiscogsNotFoundError } from "../discogs-client";
import { MAX_ATTEMPTS, NonRetryableError, type JobHandler } from "../queue/discogs-queue";
import type { DiscogsRelease } from "../types/discogs-api";
import { mapDiscogsReleaseToRow } from "./release-mapper";
import { stripReleaseBody } from "./release-raw";

export interface ReleaseDetailHandlerDeps {
  db: Db;
  /** The collector's Discogs token, or null when they have none (the job then fails). */
  getToken: (uid: string) => string | null;
  getRelease: (releaseId: number, token: string) => Promise<DiscogsRelease>;
  /** The marketplace currency of the Discogs account a token belongs to; null when Discogs has none. */
  getCurrency: (username: string, token: string) => Promise<string | null>;
}

/** Discogs no longer has the release; it is marked missing and the job ends. */
export class ReleaseMissingError extends NonRetryableError {}

/**
 * Fetches one release from Discogs and stores it with its rating, clearing a missing mark, and
 * keeps the whole response in `release_raw` (fader-ui#149). A
 * Discogs 404 is retried like any failure (the queue allows MAX_ATTEMPTS tries); on the last one
 * the release is marked missing and noted on the run. An inline refresh (`once`) does not retry.
 */
export function createReleaseDetailHandler(deps: ReleaseDetailHandlerDeps): JobHandler<ReleaseDetailPayload> {
  return async ({ uid, releaseId, once }, { runId, attempt = 1 }) => {
    const token = deps.getToken(uid);
    if (!token) throw new NonRetryableError("No Discogs token saved");

    let raw: DiscogsRelease;
    try {
      raw = await deps.getRelease(releaseId, token);
    } catch (err) {
      if (err instanceof DiscogsNotFoundError) {
        if (!once && attempt < MAX_ATTEMPTS) throw err;
        markMissing(deps.db, runId, releaseId);
        throw new ReleaseMissingError(err.message);
      }
      throw err;
    }

    const row = mapDiscogsReleaseToRow(raw, new Date(), await accountCurrency(deps, uid, token));
    deps.db.transaction(() => {
      deps.db.insert(releases).values(row).onConflictDoUpdate({ target: releases.id, set: row }).run();
      storeRaw(deps.db, raw, row.enrichedAt!);
    });
  };
}

/**
 * The currency `lowest_price` came in: the collector's Discogs account currency, which Discogs
 * prices a release in. It is asked of Discogs once and kept on the token (fader-ui#154); null when
 * Discogs does not say.
 */
async function accountCurrency(deps: ReleaseDetailHandlerDeps, uid: string, token: string): Promise<string | null> {
  const account = deps.db
    .select({ username: discogsTokens.username, currency: discogsTokens.currency })
    .from(discogsTokens)
    .where(eq(discogsTokens.uid, uid))
    .get();
  if (!account) return null;
  if (account.currency) return account.currency;

  const currency = await deps.getCurrency(account.username, token);
  if (currency) deps.db.update(discogsTokens).set({ currency }).where(eq(discogsTokens.uid, uid)).run();
  return currency;
}

/** Keeps the response in `release_raw`, unless Discogs reports no change since the stored copy. */
function storeRaw(db: Db, raw: DiscogsRelease, fetchedAt: Date): void {
  if (raw.date_changed !== undefined) {
    const stored = db
      .select({
        dateChanged: sql<string | null>`json_extract(${releaseRaw.body}, '$.date_changed')`,
      })
      .from(releaseRaw)
      .where(eq(releaseRaw.releaseId, raw.id))
      .get();
    if (stored?.dateChanged === raw.date_changed) return;
  }
  const values = { releaseId: raw.id, body: stripReleaseBody(raw), fetchedAt };
  db.insert(releaseRaw).values(values).onConflictDoUpdate({ target: releaseRaw.releaseId, set: values }).run();
}

function markMissing(db: Db, runId: string, releaseId: number): void {
  db.transaction(() => {
    db.update(releases).set({ missingAt: new Date() }).where(eq(releases.id, releaseId)).run();
    if (db.select({ id: enrichmentRuns.id }).from(enrichmentRuns).where(eq(enrichmentRuns.id, runId)).get()) {
      db.insert(enrichmentNotFound).values({ runId, releaseId }).onConflictDoNothing().run();
    }
  });
}
