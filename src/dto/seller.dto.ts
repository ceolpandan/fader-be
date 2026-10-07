import type {
  ReleaseArtistStub,
  ReleaseFormat,
  ScanOrder,
  ScanPassStatus,
  ScanSort,
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
  /** The seller's active, enriched items, faded ones included. */
  forSaleCount: number;
  /** How many of forSaleCount are faded for the collector. */
  fadedCount: number;
  /** Inventory items we can reach (Discogs caps pagination) out of all the seller lists. */
  coverage: { reachable: number; total: number } | null;
}

export type IndexingPhase = "scanning" | "enriching" | "done";

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
  /** `scanning` while inventory pages are fetched, `enriching` while releases are, `done` otherwise. */
  phase: IndexingPhase;
  /** Inventory scan progress of the current run; null until page 1 is fetched. */
  scan: { pagesFetched: number; pagesTotal: number } | null;
  /** Seconds until enrichment finishes; null when unknown or not enriching. */
  etaSeconds: number | null;
  /** When the paused Discogs queue retries (ISO); null while the queue is not paused. */
  retryingAt: string | null;
  backoffMs: number | null;
  /** Inventory items we can reach (Discogs caps pagination) out of all the seller lists. */
  coverage: { reachable: number; total: number } | null;
  /** The sorted inventory passes of the current run, in the order they ran. */
  scanPasses: ScanPassDto[];
}

export interface ScanPassDto {
  sort: ScanSort;
  order: ScanOrder;
  /**
   * `capped`: Discogs refused to paginate any further, so the pass ended cleanly.
   * `failed`: a page kept failing, so the pass was abandoned and the scan moved on.
   */
  status: ScanPassStatus;
  pagesPlanned: number;
  pagesFetched: number;
  /** Listings Discogs returned in this pass. */
  itemsSeen: number;
  /** Inventory links this pass was the first of the run to see. */
  itemsNew: number;
  startedAt: string;
  endedAt: string | null;
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
  /** Items matching the current filters (faded items already excluded). */
  total: number;
  /** The seller's active, enriched items, faded ones included. Ignores filters. */
  forSaleCount: number;
  /** How many of `forSaleCount` are faded for the signed-in user. Ignores filters. */
  fadedCount: number;
}

export interface SellerInventoryFacetsDto {
  genres: string[];
  styles: string[];
  formats: string[];
  countries: string[];
}
