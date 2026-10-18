import type { ReleaseArtistStub, ReleaseFormat, ReleaseLabel } from "../db/schema";

/** The values the filter dialog offers for each category, most common first. */
export interface ReleaseFilterOptionsDto {
  genres: string[];
  styles: string[];
  formats: string[];
  countries: string[];
}

/** A row of `GET /releases`. */
export interface ReleaseListItemDto {
  releaseId: number;
  title: string;
  year: number | null;
  country: string | null;
  genres: string[];
  styles: string[];
  formats: ReleaseFormat[];
  /** Discogs community rating; null until an enrichment run has fetched the release. */
  ratingAverage: number | null;
  ratingCount: number | null;
  /** Cover thumbnail URL on Discogs; null until enriched or when Discogs has none. */
  thumb: string | null;
  artists: ReleaseArtistStub[];
  labels: ReleaseLabel[];
  /** Stored releases under the same master, this one included (1 without a master): what fading its master clears. */
  versionCount: number;
}

export interface ReleaseListPageDto {
  items: ReleaseListItemDto[];
  page: number;
  pageSize: number;
  /** Releases matching the current filters (faded ones already excluded). */
  total: number;
  /** How many releases the signed-in user has faded. Ignores filters. */
  fadedCount: number;
}
