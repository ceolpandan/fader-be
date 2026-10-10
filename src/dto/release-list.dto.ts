import type { ReleaseArtistStub, ReleaseFormat } from "../db/schema";

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
  artists: ReleaseArtistStub[];
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
