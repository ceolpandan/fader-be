/** An uploaded list of `Artist - Title` lines and what it matched. */
export interface ScrapeDto {
  id: number;
  name: string;
  createdAt: string;
  /** Distinct releases the lines matched. */
  releaseCount: number;
  /** Lines that matched no release. */
  unmatchedCount: number;
  /** Lines whose Discogs search is queued or waiting on a release fetch. */
  searchingCount: number;
  /** Lines the Discogs search matched that the collector has not committed yet. */
  uncommittedMatchCount: number;
}

export interface CreateScrapeRequestDto {
  name: string;
  /** The file's text: one `Artist - Title` per line. */
  text: string;
}

export interface RenameScrapeRequestDto {
  name: string;
}

/** Where the Discogs search for an unmatched line stands; null when it was never searched. */
export type ScrapeSearchStatusDto = "queued" | "fetching" | "no_result" | "failed" | "rejected";

export interface ScrapeUnmatchedLineDto {
  /** The line's place in the upload; it names the line when attaching a release to it. */
  position: number;
  line: string;
  searchStatus: ScrapeSearchStatusDto | null;
}

export interface ScrapeUnmatchedDto {
  /** The lines that matched no release (or none yet), as uploaded and in file order. */
  lines: ScrapeUnmatchedLineDto[];
}

export interface SearchScrapeRequestDto {
  /** The lines to search; every unmatched line not yet searched (or that found nothing or failed) when omitted. */
  positions?: number[];
}

export interface SearchScrapeResponseDto {
  /** How many searches were queued. */
  queued: number;
}

/** A line the Discogs search matched, linked to the first release it returned. */
export interface ScrapeSearchMatchDto {
  position: number;
  line: string;
  releaseId: number;
  title: string;
  artists: string[];
  /** False until the collector confirms the match; it is shown with a marker until then. */
  committed: boolean;
}

export interface ScrapeSearchMatchesDto {
  matches: ScrapeSearchMatchDto[];
}

export interface AttachReleaseRequestDto {
  /** The Discogs release id to attach to the line; it must already be in the catalogue. */
  releaseId: number;
}
