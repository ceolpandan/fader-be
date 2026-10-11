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
  genres?: string[];
  styles?: string[];
  artists: ReleaseArtistStub[];
  labels: ReleaseLabel[];
  tracklist: ReleaseTrack[];
  videos: ReleaseVideoDto[];
}
