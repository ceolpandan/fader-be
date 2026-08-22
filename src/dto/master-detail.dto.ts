import type { ArtistDto, ImageDto, TrackDto, VideoDto } from "./common";

/**
 * All fields from GET /masters/{id} kept for now — no scoping applied yet
 * (see fader-be/tasks/df-003-endpoint-scope.md for the deferred trim-down pass).
 */
export interface MasterDetailDto {
  id: number;
  main_release?: number;
  most_recent_release?: number;
  resource_url: string;
  uri?: string;
  versions_url?: string;
  main_release_url?: string;
  most_recent_release_url?: string;
  num_for_sale?: number;
  lowest_price?: number;
  images?: ImageDto[];
  genres?: string[];
  styles?: string[];
  year?: number;
  tracklist?: TrackDto[];
  artists: ArtistDto[];
  title: string;
  data_quality?: string;
  videos?: VideoDto[];
}
