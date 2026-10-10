import type { FadeKind, FadeLookupStatus, ReleaseArtistStub } from "../db/schema";

/** Provide exactly one of releaseId or masterId. */
export interface FadeRequestDto {
  releaseId?: number;
  masterId?: number;
}

/**
 * The stored fade: the master when the release is known to have one, otherwise the release
 * itself (a release we haven't resolved yet is upgraded to its master by the lookup).
 */
export interface FadeResponseDto {
  kind: FadeKind;
  id: number;
  lookupStatus: FadeLookupStatus;
}

export interface FadedIdsDto {
  masterIds: number[];
  releaseIds: number[];
  /** Release ids under the faded masters, as far as their lookups have run. */
  versionReleaseIds: number[];
  /** Fades Discogs could not resolve. They stay in place; fading again retries. */
  failedLookups: { kind: FadeKind; id: number }[];
}

/** One stored fade, with the lowest-id indexed release it hides (null fields when none is indexed). */
export interface FadedItemDto {
  kind: FadeKind;
  id: number;
  fadedAt: string;
  title: string | null;
  artists: ReleaseArtistStub[];
  year: number | null;
  thumb: string | null;
  /** Indexed releases the fade hides: the versions of a master, or 1 for a release. */
  versionsIndexed: number;
  lookupStatus: FadeLookupStatus;
}

export interface FadedItemsDto {
  items: FadedItemDto[];
  page: number;
  pageSize: number;
  /** Fades matching the search. */
  total: number;
  /** All of the collector's fades, ignoring the search. */
  fadedTotal: number;
}
