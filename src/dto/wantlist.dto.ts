import type { ReleaseArtistStub, ReleaseFormat } from "../db/schema";

/** A row of `GET /wantlist`: a wantlist item that has a `releases` row. */
export interface WantlistItemDto {
  releaseId: number;
  title: string;
  year: number | null;
  formats: ReleaseFormat[];
  artists: ReleaseArtistStub[];
  /** Copies for sale on Discogs when the release was last fetched; null until then. */
  numForSale: number | null;
  /** ISO 8601 time the collector added it on Discogs; null when Discogs did not say. */
  addedAt: string | null;
}

export interface WantlistPageDto {
  items: WantlistItemDto[];
  page: number;
  pageSize: number;
  /** Wantlist items that have a `releases` row and pass the filter: what the pages add up to. */
  total: number;
  /** Wantlist items that have a `releases` row, filter or not: the Wantlist tab's count. */
  wantlistCount: number;
  /** Wantlist items with no `releases` row yet: the Unmatched tab's count. */
  unmatchedCount: number;
  /** ISO 8601 time the newest `numForSale` among these items was fetched; null if none has been. */
  availabilityUpdatedAt: string | null;
}

/** A row of `GET /wantlist/unmatched`: a wantlist item with no `releases` row, as the Discogs payload described it. */
export interface WantlistUnmatchedItemDto {
  releaseId: number;
  title: string;
  artists: ReleaseArtistStub[];
  /** Where the entry came from; "Discogs wantlist" for now, one per import later. */
  source: string;
  addedAt: string | null;
}

export interface WantlistUnmatchedPageDto {
  items: WantlistUnmatchedItemDto[];
  page: number;
  pageSize: number;
  /** Wantlist items with no `releases` row. */
  total: number;
  /** Wantlist items that have a `releases` row: the Wantlist tab's count. */
  wantlistCount: number;
}
