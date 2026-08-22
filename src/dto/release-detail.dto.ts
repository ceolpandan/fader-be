import type {
  ArtistDto,
  CommunityDto,
  CompanyDto,
  FormatDto,
  IdentifierDto,
  ImageDto,
  LabelDto,
  TrackDto,
  VideoDto,
} from "./common";

/**
 * All fields from GET /releases/{id} kept for now — no scoping applied yet
 * (see fader-be/tasks/df-003-endpoint-scope.md for the deferred trim-down pass).
 */
export interface ReleaseDetailDto {
  id: number;
  status?: string;
  year?: number;
  resource_url: string;
  uri?: string;
  artists: ArtistDto[];
  artists_sort?: string;
  labels?: LabelDto[];
  series?: unknown[];
  companies?: CompanyDto[];
  formats?: FormatDto[];
  data_quality?: string;
  community?: CommunityDto;
  format_quantity?: number;
  date_added?: string;
  date_changed?: string;
  num_for_sale?: number;
  lowest_price?: number;
  master_id?: number;
  master_url?: string;
  title: string;
  country?: string;
  released?: string;
  notes?: string;
  released_formatted?: string;
  identifiers?: IdentifierDto[];
  videos?: VideoDto[];
  genres?: string[];
  styles?: string[];
  tracklist?: TrackDto[];
  extraartists?: ArtistDto[];
  images?: ImageDto[];
  thumb?: string;
  estimated_weight?: number;
  blocked_from_sale?: boolean;
  is_offensive?: boolean;
}
