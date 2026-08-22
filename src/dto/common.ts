export interface ArtistDto {
  id: number;
  name: string;
  anv?: string;
  join?: string;
  role?: string;
  tracks?: string;
  resource_url: string;
  thumbnail_url?: string;
}

export interface LabelDto {
  id: number;
  name: string;
  catno?: string;
  entity_type?: string;
  entity_type_name?: string;
  resource_url: string;
  thumbnail_url?: string;
}

export type CompanyDto = LabelDto;

export interface FormatDto {
  name: string;
  qty?: string;
  text?: string;
  descriptions?: string[];
}

export interface IdentifierDto {
  type: string;
  value: string;
  description?: string;
}

export interface VideoDto {
  uri: string;
  title?: string;
  description?: string;
  duration?: number;
  embed?: boolean;
}

export interface TrackDto {
  position: string;
  type_?: string;
  title: string;
  duration?: string;
  extraartists?: ArtistDto[];
}

export interface ImageDto {
  type: string;
  uri: string;
  resource_url: string;
  uri150?: string;
  width?: number;
  height?: number;
}

export interface CommunityUserDto {
  username: string;
  resource_url: string;
}

export interface CommunityDto {
  have?: number;
  want?: number;
  rating?: {
    count: number;
    average: number;
  };
  submitter?: CommunityUserDto;
  contributors?: CommunityUserDto[];
  data_quality?: string;
  status?: string;
}
