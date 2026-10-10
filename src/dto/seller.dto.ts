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

/** What Discogs says about a Seller we may not have indexed yet; nothing is stored. */
export interface SellerPreviewDto {
  /** Under the casing Discogs reports. */
  username: string;
  avatarUrl: string | null;
  /** Seller rating as a percentage, e.g. 96.4; null for a Seller who has never sold. */
  sellerRating: number | null;
  sellerNumRatings: number | null;
  /** From the first listing; null when the Seller has none or Discogs could not be asked. */
  shipsFromCountry: string | null;
  /** Listings Discogs reports for the Seller. */
  numForSale: number;
  marketplaceSuspended: boolean;
  /** Rough time a full indexing run takes at the Discogs request pace. */
  estimatedSeconds: number;
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

/** One copy of a release a seller has for sale. */
export interface ListingDto {
  id: number;
  mediaCondition: string;
  sleeveCondition: string | null;
  price: number;
  /** ISO 4217 code as Discogs reports it; prices are not converted between currencies. */
  currency: string;
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
  /** Every listing of the release, cheapest first within a currency. Empty until the seller is next indexed. */
  listings: ListingDto[];
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

/** A facet value with how many of the releases matching the current filters carry it. */
export interface FacetValueDto {
  value: string;
  count: number;
}

/** A currency a seller lists in, with how many of their releases have a listing in it. */
export interface PriceCurrencyDto {
  currency: string;
  count: number;
}

/** A price range with how many releases have a listing in it; a null end is open. Ends are inclusive. */
export interface PriceBucketDto {
  min: number | null;
  max: number | null;
  count: number;
}

/** The values of each category among the releases matching the filters, most common first. */
export interface ReleaseFacetsDto {
  genres: FacetValueDto[];
  styles: FacetValueDto[];
  formats: FacetValueDto[];
  countries: FacetValueDto[];
}

export interface SellerInventoryFacetsDto extends ReleaseFacetsDto {
  /** Every currency the seller lists in, most common first; ignores the filters. */
  currencies: PriceCurrencyDto[];
  /** The currency of `priceBuckets`: the `currency` param, else the most common one. Null with no listings. */
  currency: string | null;
  /** Up to six price ranges in `currency`, counted among releases matching every filter but price. */
  priceBuckets: PriceBucketDto[];
}

/** A row of `GET /releases`: a seller inventory item without the seller-specific fields. */
export type ReleaseListItemDto = Omit<SellerInventoryItemDto, "status" | "firstSeenAt" | "soldAt" | "listings">;

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
