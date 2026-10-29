import type { DigitalMatchTrack } from "../db/schema";
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
