import type { Db } from "../db/client";
import { releases } from "../db/schema";
import type { ReleaseDetailPayload } from "../db/schema";
import { DiscogsNotFoundError } from "../discogs-client";
import { NonRetryableError, type JobHandler } from "../queue/discogs-queue";
import type { DiscogsRelease } from "../types/discogs-api";
import { mapDiscogsReleaseToRow } from "./release-mapper";

export interface ReleaseDetailHandlerDeps {
  db: Db;
  getRelease: (releaseId: number) => Promise<DiscogsRelease>;
}

export function createReleaseDetailHandler(
  deps: ReleaseDetailHandlerDeps,
): JobHandler<ReleaseDetailPayload> {
  return async (payload) => {
    let raw: DiscogsRelease;
    try {
      raw = await deps.getRelease(payload.releaseId);
    } catch (err) {
      if (err instanceof DiscogsNotFoundError) {
        throw new NonRetryableError(err.message);
      }
      throw err;
    }

    const row = mapDiscogsReleaseToRow(raw);

    deps.db.insert(releases).values(row).onConflictDoUpdate({ target: releases.id, set: row }).run();
  };
}
