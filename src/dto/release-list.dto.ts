import type { ReleaseArtistStub, ReleaseFormat } from "../db/schema";

/** A facet value with how many of the releases matching the current filters carry it. */
export interface FacetValueDto {
  value: string;
  count: number;
}

/** The values of each category among the releases matching the filters, most common first. */
export interface ReleaseFacetsDto {
  genres: FacetValueDto[];
  styles: FacetValueDto[];
  formats: FacetValueDto[];
  countries: FacetValueDto[];
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
