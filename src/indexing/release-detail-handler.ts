import type { Db } from "../db/client";
import { releases } from "../db/schema";
import type { ReleaseDetailPayload } from "../db/schema";
import { DiscogsNotFoundError } from "../discogs-client";
import { NonRetryableError, type JobHandler } from "../queue/discogs-queue";
import type { DiscogsRelease } from "../types/discogs-api";

export interface ReleaseDetailHandlerDeps {
  db: Db;
  getRelease: (releaseId: number) => Promise<DiscogsRelease>;
}

function mapDiscogsReleaseToRow(raw: DiscogsRelease): typeof releases.$inferInsert {
  return {
    id: raw.id,
    title: raw.title,
    year: raw.year ?? null,
    country: raw.country ?? null,
    genres: raw.genres ?? [],
    styles: raw.styles ?? [],
    formats: (raw.formats ?? []).map((format) => ({
      name: format.name,
      descriptions: format.descriptions ?? [],
    })),
    masterId: raw.master_id ?? null,
    thumb: raw.thumb ?? null,
    ratingAverage: raw.community?.rating?.average ?? null,
    ratingCount: raw.community?.rating?.count ?? null,
    haves: raw.community?.have ?? null,
    wants: raw.community?.want ?? null,
    labelIds: (raw.labels ?? []).map((label) => label.id),
    artists: raw.artists.map((artist) => ({ id: artist.id, name: artist.name })),
  };
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
