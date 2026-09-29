import type { ReleaseArtistStub, ReleaseTrack, ReleaseVideo } from "../db/schema";

/** GET /releases/{id} — served from our own `releases` table, not live Discogs. */
export interface ReleaseDetailDto {
  id: number;
  title: string;
  thumb?: string;
  artists: ReleaseArtistStub[];
  tracklist: ReleaseTrack[];
  videos: ReleaseVideo[];
}
