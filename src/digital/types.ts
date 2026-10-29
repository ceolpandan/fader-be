/** The digital stores a release can be checked against. */
export type DigitalStoreId = "bandcamp";

export const DIGITAL_STORE_IDS: readonly DigitalStoreId[] = ["bandcamp"];

/** One search result as a store lists it. */
export interface StoreHit {
  kind: "album" | "track";
  title: string;
  artist: string;
  /** The album a track is on, when the store says; null for an album hit and for a loose track. */
  album: string | null;
  url: string;
}

/** What a store needs to repeat the collector's browser requests: the headers of a pasted curl, cookies included. */
export interface StoreSession {
  headers: Record<string, string>;
}

/**
 * A digital store a release can be checked against. A store declares the searches it can do, so a
 * track-first store can leave out the album search; the check (`check-release.ts`) owns the policy
 * of which to try and when a hit counts. See `docs/adr/0011-digital-store-strategy.md`.
 */
export interface DigitalStore {
  id: DigitalStoreId;
  searchReleases?(session: StoreSession, query: string): Promise<StoreHit[]>;
  searchTracks?(session: StoreSession, query: string): Promise<StoreHit[]>;
}

/** The store refused the session (a bot challenge or a 403): the collector has to paste a fresh curl. */
export class StoreSessionExpiredError extends Error {
  constructor(message = "The digital store did not accept the session") {
    super(message);
    this.name = "StoreSessionExpiredError";
  }
}

/** The store failed (429, 5xx or no answer): worth trying again later. */
export class StoreUnavailableError extends Error {
  constructor(message = "The digital store is unavailable") {
    super(message);
    this.name = "StoreUnavailableError";
  }
}

export type DigitalMatchStatus = "album" | "tracks" | "none";

/** A track of a release found on a store. */
export interface FoundTrack {
  /** The Discogs position of the track ("A1"). */
  position: string;
  title: string;
  url: string;
}

/** What checking one release against one store found. */
export interface DigitalMatchResult {
  status: DigitalMatchStatus;
  /** The album's URL for `album`; null otherwise. */
  url: string | null;
  /** The tracks that were found, for `tracks`; empty otherwise. */
  tracks: FoundTrack[];
  /** How many of the release's tracks were searched, for `tracks` and `none`; null for `album`. */
  trackCount: number | null;
}
