import type { ReleaseArtistStub, ReleaseLabel, ReleaseTrack } from "../db/schema";

/** A video of a release; `uri` is the dump's `src`. */
export interface ReleaseVideoDto {
  uri: string;
  title?: string;
  duration?: number;
}

/** GET /releases/{id} — served from our own `releases` table, not live Discogs. */
export interface ReleaseDetailDto {
  id: number;
  title: string;
  year: number | null;
  country: string | null;
  /** Cover thumbnail URL on Discogs; null until enriched or when Discogs has none. */
  thumb: string | null;
  /** The cheapest current price on Discogs when the release was last fetched, in `lowestPriceCurrency`; null until then, or when it was not in euro. */
  lowestPrice: number | null;
  /** The currency of `lowestPrice` (always "EUR" for now); null when there is no price. */
  lowestPriceCurrency: string | null;
  genres?: string[];
  styles?: string[];
  artists: ReleaseArtistStub[];
  labels: ReleaseLabel[];
  tracklist: ReleaseTrack[];
  videos: ReleaseVideoDto[];
}
