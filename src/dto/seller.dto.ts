import type {
  ReleaseArtistStub,
  ReleaseFormat,
  SellerIndexStatus,
  SellerInventoryStatus,
} from "../db/schema";

export interface IndexStartedDto {
  username: string;
  runId: string;
}

export interface SellerSummaryDto {
  username: string;
  lastIndexedAt: string | null;
  lastIndexStatus: SellerIndexStatus;
}

export interface SellerStatusDto {
  username: string;
  lastIndexedAt: string | null;
  lastIndexStatus: SellerIndexStatus;
  currentlyRunning: boolean;
  totalReleasesFound: number;
  releasesEnriched: number;
  releasesFailed: number;
  /** Seller rating as a percentage, e.g. 96.4. */
  sellerRating: number | null;
  sellerNumRatings: number | null;
  shipsFromCountry: string | null;
}

export interface SellerInventoryItemDto {
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
  status: SellerInventoryStatus;
  firstSeenAt: string;
  soldAt: string | null;
}

export interface SellerInventoryPageDto {
  items: SellerInventoryItemDto[];
  page: number;
  pageSize: number;
  total: number;
}

export interface SellerInventoryFacetsDto {
  genres: string[];
  styles: string[];
  formats: string[];
  countries: string[];
}
