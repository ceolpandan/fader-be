/** The collector's Discogs profile as last fetched. */
export interface DiscogsProfileDataDto {
  username: string;
  /** Copies in the collection; a release owned twice counts twice. */
  collectionCount: number;
  wantlistCount: number;
  /** ISO 8601 time of the fetch. */
  fetchedAt: string;
}

export interface DiscogsProfileDto {
  /** Whether the collector has saved a Discogs token; without one there is nothing to fetch. */
  tokenSet: boolean;
  /** Null until the first fetch, and whenever there is no token. */
  profile: DiscogsProfileDataDto | null;
}
