import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { discogsProfiles, discogsTokens, type DiscogsProfilePayload } from "../db/schema";
import { NonRetryableError, PACING_MS, type JobHandler } from "../queue/discogs-queue";

export interface DiscogsProfileHandlerDeps {
  db: Db;
  /** The collector's Discogs token, or null when they have none (the job then fails). */
  getToken: (uid: string) => string | null;
  getCollectionCount: (username: string, token: string) => Promise<number>;
  getWantlistCount: (username: string, token: string) => Promise<number>;
  /** Waits between the two Discogs requests; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fetches the collector's collection and wantlist counts and caches them for the home page. The
 * username is the one Discogs gave when the token was saved. The two requests are spaced like the
 * queue spaces jobs, so one job never bursts past the rate limit. The cache is written only when
 * both counts are in.
 */
export function createDiscogsProfileHandler(deps: DiscogsProfileHandlerDeps): JobHandler<DiscogsProfilePayload> {
  const sleep = deps.sleep ?? wait;

  return async ({ uid }) => {
    const token = deps.getToken(uid);
    const username = deps.db
      .select({ username: discogsTokens.username })
      .from(discogsTokens)
      .where(eq(discogsTokens.uid, uid))
      .get()?.username;
    if (!token || !username) throw new NonRetryableError("No Discogs token saved");

    const collectionCount = await deps.getCollectionCount(username, token);
    await sleep(PACING_MS);
    const wantlistCount = await deps.getWantlistCount(username, token);

    const values = { username, collectionCount, wantlistCount, fetchedAt: new Date() };
    deps.db
      .insert(discogsProfiles)
      .values({ uid, ...values })
      .onConflictDoUpdate({ target: discogsProfiles.uid, set: values })
      .run();
  };
}
