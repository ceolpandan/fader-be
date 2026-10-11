import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { enrichmentNotFound, enrichmentRuns, releases } from "../db/schema";
import type { ReleaseDetailPayload } from "../db/schema";
import { DiscogsNotFoundError } from "../discogs-client";
import { MAX_ATTEMPTS, NonRetryableError, type JobHandler } from "../queue/discogs-queue";
import type { DiscogsRelease } from "../types/discogs-api";
import { mapDiscogsReleaseToRow } from "./release-mapper";

export interface ReleaseDetailHandlerDeps {
  db: Db;
  /** The collector's Discogs token, or null when they have none (the job then fails). */
  getToken: (uid: string) => string | null;
  getRelease: (releaseId: number, token: string) => Promise<DiscogsRelease>;
}

/** Discogs no longer has the release; it is marked missing and the job ends. */
export class ReleaseMissingError extends NonRetryableError {}

/**
 * Fetches one release from Discogs and stores it with its rating, clearing a missing mark. A
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

    const row = mapDiscogsReleaseToRow(raw, new Date());
    deps.db.insert(releases).values(row).onConflictDoUpdate({ target: releases.id, set: row }).run();
  };
}

function markMissing(db: Db, runId: string, releaseId: number): void {
  db.transaction(() => {
    db.update(releases).set({ missingAt: new Date() }).where(eq(releases.id, releaseId)).run();
    if (db.select({ id: enrichmentRuns.id }).from(enrichmentRuns).where(eq(enrichmentRuns.id, runId)).get()) {
      db.insert(enrichmentNotFound).values({ runId, releaseId }).onConflictDoNothing().run();
    }
  });
}
