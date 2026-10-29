import { logger } from "../../util/logger";
import {
  StoreSessionExpiredError,
  StoreUnavailableError,
  type DigitalStore,
  type StoreHit,
  type StoreSession,
} from "../types";
import { isChallengePage, parseSearchResults } from "./parse";

export const BANDCAMP_HOST = "bandcamp.com";
const SEARCH_URL = `https://${BANDCAMP_HOST}/search`;
const REQUEST_TIMEOUT_MS = 15_000;

type Fetch = typeof fetch;

/**
 * Bandcamp's search page, read with the collector's pasted headers. Searching needs no login, but
 * without a browser's headers and cookies the page is a bot check instead of results.
 */
export function createBandcampStore(fetchPage: Fetch = fetch): DigitalStore {
  async function search(session: StoreSession, query: string, itemType: "a" | "t"): Promise<StoreHit[]> {
    // encodeURIComponent, not URLSearchParams: the browser writes a space as %20, not "+".
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&item_type=${itemType}`;
    let res: Response;
    try {
      res = await fetchPage(url, {
        headers: { ...session.headers, "sec-fetch-site": "none" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      logger.warn(`Bandcamp did not answer: ${err instanceof Error ? err.message : String(err)}`);
      throw new StoreUnavailableError("Bandcamp did not answer");
    }
    if (res.status === 403) throw new StoreSessionExpiredError();
    if (!res.ok) throw new StoreUnavailableError(`Bandcamp answered ${res.status}`);

    const html = await res.text();
    if (isChallengePage(html)) throw new StoreSessionExpiredError("Bandcamp asked for a client challenge");
    return parseSearchResults(html);
  }

  return {
    id: "bandcamp",
    searchReleases: (session, query) => search(session, query, "a"),
    searchTracks: (session, query) => search(session, query, "t"),
  };
}
