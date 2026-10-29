import { BANDCAMP_HOST, createBandcampStore } from "./bandcamp/bandcamp-store";
import { PacedLane } from "./paced-lane";
import { StoreSessions } from "./store-sessions";
import type { DigitalStore, DigitalStoreId } from "./types";

/** Time between two requests to the same store. */
export const STORE_REQUEST_GAP_MS = 1200;

/** A store with the one lane its requests go through. */
export interface RegisteredStore {
  store: DigitalStore;
  lane: PacedLane;
  /** The host a pasted curl must be for. */
  host: string;
}

export interface DigitalStores {
  stores: Partial<Record<DigitalStoreId, RegisteredStore>>;
  sessions: StoreSessions;
}

/** The stores Fader can check; a new store is added here and nowhere else. */
export function createDigitalStores(gapMs: number = STORE_REQUEST_GAP_MS): DigitalStores {
  return {
    stores: {
      bandcamp: { store: createBandcampStore(), lane: new PacedLane(gapMs), host: BANDCAMP_HOST },
    },
    sessions: new StoreSessions(),
  };
}
