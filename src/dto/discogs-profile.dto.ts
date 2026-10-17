/** The collector's Discogs profile as last fetched. */
export interface DiscogsProfileDataDto {
  username: string;
  /** Releases in the collection. Before the first sync it is Discogs' own copy count, which counts a release owned twice twice. */
  collectionCount: number;
  wantlistCount: number;
  /** ISO 8601 time of the fetch. */
  fetchedAt: string;
  /** ISO 8601 time the last sync completed; null until the first one does. */
  lastSyncedAt: string | null;
}

/** Where the sync of the collection and wantlist stands. */
export interface DiscogsSyncDto {
  /** `running` covers queued, running and paused-and-retrying; `failed` keeps the last sync's error until the next one starts. */
  status: "idle" | "running" | "failed";
  /** What the collector can act on; set only while `status` is `failed`. */
  error: string | null;
}

export interface DiscogsProfileDto {
  /** Whether the collector has saved a Discogs token; without one there is nothing to fetch. */
  tokenSet: boolean;
  /** Null until the first fetch, and whenever there is no token. */
  profile: DiscogsProfileDataDto | null;
  sync: DiscogsSyncDto;
}
