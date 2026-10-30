import type { DigitalMatchTrack, ReleaseArtistStub } from "../db/schema";
import type { DigitalMatchStatus, DigitalStoreId } from "../digital/types";

/** What checking a release against one digital store found. */
export interface DigitalMatchDto {
  store: DigitalStoreId;
  status: DigitalMatchStatus;
  /** The album's URL for `album`; null for `tracks` and `none`. */
  url: string | null;
  /** The tracks that were found, for `tracks`; empty otherwise. */
  tracks: DigitalMatchTrack[];
  /** How many of the release's tracks were searched, for `tracks` and `none`; null for `album`. */
  trackCount: number | null;
  /** ISO 8601 time of the check. */
  checkedAt: string;
}

/** Body of `PUT /digital/{store}/session`. */
export interface SaveStoreSessionRequestDto {
  /** A curl command copied from the browser ("Copy as cURL"). */
  curl: string;
}

/** Answer to `PUT /digital/{store}/session`. */
export interface StoreSessionDto {
  store: DigitalStoreId;
  /** ISO 8601 time the session is forgotten. */
  expiresAt: string;
}

/** Body of `POST /digital/{store}/matches`. */
export interface CheckDigitalMatchRequestDto {
  releaseId: number;
}

/** Body of `POST /digital/{store}/scan`. */
export interface StartDigitalScanRequestDto {
  /** Also check the items that already have a result; false (the default) leaves them alone. */
  recheck?: boolean;
}

/** The wantlist item a scan is checking. */
export interface DigitalScanCurrentDto {
  releaseId: number;
  title: string;
  artists: ReleaseArtistStub[];
}

/**
 * A scan of the wantlist against one digital store. `running` checks, `paused` waits out a store
 * error (`pausedUntil`), `needs-session` stopped for a fresh curl and carries on once one is
 * pasted, the rest have ended.
 */
export interface DigitalScanDto {
  store: DigitalStoreId;
  status: "running" | "paused" | "needs-session" | "done" | "cancelled" | "failed";
  recheck: boolean;
  /** The items the scan set out to check. */
  total: number;
  /** Items checked so far: `album` + `tracks` + `none`. */
  checked: number;
  album: number;
  tracks: number;
  none: number;
  /** Unmatched wantlist items (no release stored yet), which a scan cannot check. */
  skipped: number;
  /** Items that could not be checked, which the scan moved on from. */
  failed: number;
  /** Requests made to the store so far. */
  requestsDone: number;
  /** An estimate of the requests still to make: the most the unchecked items could take, scaled by how many the checked ones took. */
  requestsRemaining: number;
  /** Seconds left, from the requests remaining at the store's pace plus any pause; null unless running or paused. */
  etaSeconds: number | null;
  /** The item being checked; null between items and once the scan has ended. */
  current: DigitalScanCurrentDto | null;
  /** ISO 8601 time the store is tried again, while paused. */
  pausedUntil: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** Answer to `GET /digital/{store}/scan`. */
export interface DigitalScanStatusDto {
  scan: DigitalScanDto | null;
}
