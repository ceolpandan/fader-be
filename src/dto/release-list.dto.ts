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
  thumb: string | null;
  year: number | null;
  country: string | null;
  genres: string[];
  styles: string[];
  formats: ReleaseFormat[];
  ratingAverage: number | null;
  ratingCount: number | null;
  haves: number | null;
  wants: number | null;
  artists: ReleaseArtistStub[];
}

export interface ReleaseListPageDto {
  items: ReleaseListItemDto[];
  page: number;
  pageSize: number;
  /** Releases matching the current filters (faded ones already excluded). */
  total: number;
  /** All enriched releases, faded ones included. Ignores filters. */
  enrichedCount: number;
  /** How many of `enrichedCount` are faded for the signed-in user. Ignores filters. */
  fadedCount: number;
}
