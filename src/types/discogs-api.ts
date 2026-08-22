/**
 * Raw Discogs API v2 response shapes for the endpoints this service wraps.
 * Captured against live responses:
 *   GET https://api.discogs.com/releases/{release_id}
 *   GET https://api.discogs.com/masters/{master_id}
 * All fields included as observed — no scoping/trimming at this layer.
 */

export interface DiscogsArtist {
  id: number;
  name: string;
  anv?: string;
  join?: string;
  role?: string;
  tracks?: string;
  resource_url: string;
  thumbnail_url?: string;
}

export interface DiscogsLabel {
  id: number;
  name: string;
  catno?: string;
  entity_type?: string;
  entity_type_name?: string;
  resource_url: string;
  thumbnail_url?: string;
}

export type DiscogsCompany = DiscogsLabel;

export interface DiscogsFormat {
  name: string;
  qty?: string;
  text?: string;
  descriptions?: string[];
}

export interface DiscogsIdentifier {
  type: string;
  value: string;
  description?: string;
}

export interface DiscogsVideo {
  uri: string;
  title?: string;
  description?: string;
  duration?: number;
  embed?: boolean;
}

export interface DiscogsTrack {
  position: string;
  type_?: string;
  title: string;
  duration?: string;
  extraartists?: DiscogsArtist[];
}

export interface DiscogsImage {
  type: string;
  uri: string;
  resource_url: string;
  uri150?: string;
  width?: number;
  height?: number;
}

export interface DiscogsCommunityUser {
  username: string;
  resource_url: string;
}

export interface DiscogsCommunity {
  have?: number;
  want?: number;
  rating?: {
    count: number;
    average: number;
  };
  submitter?: DiscogsCommunityUser;
  contributors?: DiscogsCommunityUser[];
  data_quality?: string;
  status?: string;
}

export interface DiscogsRelease {
  id: number;
  status?: string;
  year?: number;
  resource_url: string;
  uri?: string;
  artists: DiscogsArtist[];
  artists_sort?: string;
  labels?: DiscogsLabel[];
  series?: unknown[];
  companies?: DiscogsCompany[];
  formats?: DiscogsFormat[];
  data_quality?: string;
  community?: DiscogsCommunity;
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
  identifiers?: DiscogsIdentifier[];
  videos?: DiscogsVideo[];
  genres?: string[];
  styles?: string[];
  tracklist?: DiscogsTrack[];
  extraartists?: DiscogsArtist[];
  images?: DiscogsImage[];
  thumb?: string;
  estimated_weight?: number;
  blocked_from_sale?: boolean;
  is_offensive?: boolean;
}

export interface DiscogsMasterVersion {
  id: number;
  label?: string;
  country?: string;
  title: string;
  major_formats?: string[];
  format?: string;
  catno?: string;
  released?: string;
  status?: string;
  resource_url: string;
  thumb?: string;
}

export interface DiscogsPagination {
  page: number;
  pages: number;
  per_page: number;
  items: number;
}

export interface DiscogsMasterVersionsResponse {
  pagination: DiscogsPagination;
  versions: DiscogsMasterVersion[];
}

export interface DiscogsMaster {
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
  images?: DiscogsImage[];
  genres?: string[];
  styles?: string[];
  year?: number;
  tracklist?: DiscogsTrack[];
  artists: DiscogsArtist[];
  title: string;
  data_quality?: string;
  videos?: DiscogsVideo[];
}
