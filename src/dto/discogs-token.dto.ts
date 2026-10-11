/** Whether the collector has a Discogs token stored. The token itself is never returned. */
export interface DiscogsTokenDto {
  set: boolean;
  /** The Discogs account the token belongs to; null when none is set. */
  username: string | null;
}

export interface SetDiscogsTokenRequestDto {
  token: string;
}
