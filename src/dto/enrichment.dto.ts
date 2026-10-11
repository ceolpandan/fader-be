import type { EnrichmentRunStatus, ReleaseArtistStub } from "../db/schema";

/** What a run would do for a filter, before it is started. */
export interface EnrichmentPreviewDto {
  /** Releases the run would fetch from Discogs. */
  count: number;
  /** Releases matching the filter that the run leaves alone. */
  skipped: number;
  /** The most releases one run may fetch; null when there is no limit. */
  max: number | null;
}

export interface StartEnrichmentRunRequestDto {
  /** The Explore query string, without `page`. */
  query: string;
  /** Fetch releases that were already enriched again. */
  fresh?: boolean;
}

export interface EnrichmentNotFoundDto {
  releaseId: number;
  title: string;
  artists: ReleaseArtistStub[];
}

export interface EnrichmentRunDto {
  id: string;
  status: EnrichmentRunStatus;
  query: string;
  fresh: boolean;
  /** Releases queued for the run. */
  total: number;
  /** Matching releases left alone: already enriched, or queued by another run. */
  skipped: number;
  enriched: number;
  /** Discogs no longer has them; Explore hides them. */
  notFound: number;
  failed: number;
  remaining: number;
  startedAt: string;
  finishedAt: string | null;
  /** Why a failed run stopped. */
  errorMessage: string | null;
  /** While Discogs is erroring: when the run tries again. */
  pausedUntil: string | null;
  notFoundReleases: EnrichmentNotFoundDto[];
}

/** The collector's active run, or their last one; null before they ever started one. */
export interface EnrichmentStatusDto {
  run: EnrichmentRunDto | null;
}
