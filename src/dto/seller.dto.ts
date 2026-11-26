import type { ScanOrder, ScanPassStatus, ScanSort, SellerIndexStatus } from "../db/schema";

export interface IndexStartedDto {
  username: string;
  runId: string;
}

/** How much of a seller's inventory the scan reached (Discogs caps pagination) out of all they list. */
export interface SellerCoverageDto {
  reachable: number;
  total: number;
}

export interface SellerSummaryDto {
  /** Under the casing Discogs reports. */
  username: string;
  avatarUrl: string | null;
  lastIndexedAt: string | null;
  lastIndexStatus: SellerIndexStatus;
  /** The seller's active items that are in the catalogue, faded ones included. */
  forSaleCount: number;
  /** How many of forSaleCount are faded for the collector. */
  fadedCount: number;
  coverage: SellerCoverageDto | null;
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
  avatarUrl: string | null;
  /** `scanning` while inventory pages are fetched, `enriching` while releases are, `done` otherwise. */
  phase: IndexingPhase;
  /** Inventory scan progress of the current run; null until page 1 is fetched. */
  scan: { pagesFetched: number; pagesTotal: number } | null;
  /** Seconds until enrichment finishes; null when unknown or not enriching. */
  etaSeconds: number | null;
  /** When the paused Discogs queue retries (ISO); null while the queue is not paused. */
  retryingAt: string | null;
  backoffMs: number | null;
  coverage: SellerCoverageDto | null;
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
