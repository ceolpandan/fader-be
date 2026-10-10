import type { FadeKind, ReleaseArtistStub } from "../db/schema";

/** Provide exactly one of releaseId or masterId. */
export interface FadeRequestDto {
  releaseId?: number;
  masterId?: number;
}

/** The stored fade: the master when the release has one, otherwise the release itself. */
export interface FadeResponseDto {
  kind: FadeKind;
  id: number;
}

export interface FadedIdsDto {
  masterIds: number[];
  releaseIds: number[];
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
