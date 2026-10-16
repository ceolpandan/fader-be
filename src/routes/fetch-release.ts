import { randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import { getDiscogsToken } from "../db/discogs-tokens";
import { DiscogsAuthError } from "../discogs-client";
import {
  NonRetryableError,
  QueueUnavailableError,
  QueueWaitTimeoutError,
  type DiscogsQueue,
} from "../queue/discogs-queue";
import { logger } from "../util/logger";

/** Why a release could not be fetched: the status and body to answer with. */
export interface FetchReleaseFailure {
  status: number;
  body: { error: string; code?: string };
}

/**
 * Fetches one release from Discogs ahead of any queued run (inline priority), with the
 * collector's own token, and stores it, a rating included. Resolves to null once it is stored.
 */
export async function fetchReleaseFromDiscogs(
  deps: { db: Db; queue: DiscogsQueue },
  uid: string,
  releaseId: number,
): Promise<FetchReleaseFailure | null> {
  if (!getDiscogsToken(deps.db, uid)) {
    return {
      status: 409,
      body: { error: "Add a Discogs token in Settings to refresh a release", code: "token_required" },
    };
  }

  try {
    await deps.queue.enqueueAndWait({
      runId: `inline-${randomUUID()}`,
      type: "release_detail",
      payload: { uid, releaseId, once: true },
    });
  } catch (err) {
    if (err instanceof DiscogsAuthError) {
      return { status: 409, body: { error: "Discogs rejected your token", code: "token_required" } };
    }
    if (err instanceof NonRetryableError) {
      return { status: 404, body: { error: "Release not found on Discogs", code: "release_not_found" } };
    }
    if (err instanceof QueueUnavailableError) {
      return { status: 503, body: { error: "Discogs unavailable, retrying" } };
    }
    if (err instanceof QueueWaitTimeoutError) {
      return { status: 504, body: { error: "Timed out waiting for release from Discogs" } };
    }
    logger.error("Failed to refresh release from Discogs", err);
    return { status: 502, body: { error: "Failed to fetch release from Discogs" } };
  }
  return null;
}
