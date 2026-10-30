import type { ReleaseArtistStub, ReleaseTrack } from "../db/schema";
import { logger } from "../util/logger";
import { artistsMatch, isVariousArtists, searchQuery, titlesMatch } from "./match";
import type { PacedLane } from "./paced-lane";
import type { DigitalMatchResult, DigitalStore, FoundTrack, StoreHit, StoreSession } from "./types";

export interface CheckableRelease {
  id: number;
  title: string;
  artists: ReleaseArtistStub[];
  tracklist: ReleaseTrack[];
}

/** How many near-misses a miss logs, so the matching rules can be loosened after a test run. */
const LOGGED_REJECTS = 3;

export interface CheckOptions {
  /** The lane priority of the requests: `CHECK_PRIORITY` for a check a person waits on, 0 (the default) for a scan. */
  priority?: number;
  /** Called as each request to the store is made, so a scan can count them. */
  onRequest?: () => void;
  /** Once aborted, the check makes no further request and throws. */
  signal?: AbortSignal;
}

/** The most requests checking the release takes: the album search plus a search for every track, as far as the store does either. */
export function maxRequests(store: DigitalStore, release: CheckableRelease): number {
  const album = store.searchReleases && !isVariousArtists(release.artists) ? 1 : 0;
  return album + (store.searchTracks ? searchableTracks(release).length : 0);
}

/** A heading in the tracklist ("Side A") has no position and is not a track. */
function searchableTracks(release: CheckableRelease): ReleaseTrack[] {
  return release.tracklist.filter((t) => t.position.trim() !== "");
}

/**
 * Checks one release against one store: the album first, and only when that is not found, every
 * track. Every request goes through the store's lane. Throws what the store throws
 * (`StoreSessionExpiredError`, `StoreUnavailableError`).
 *
 * A hit counts when its title matches and its artist is one of the release's. A compilation
 * ("Various") names no artist to check, so its album is not searched and a track counts when it
 * is on an album of the same title.
 */
export async function checkRelease(
  store: DigitalStore,
  lane: PacedLane,
  session: StoreSession,
  release: CheckableRelease,
  { priority = 0, onRequest, signal }: CheckOptions = {},
): Promise<DigitalMatchResult> {
  const request = <T>(task: () => Promise<T>): Promise<T> =>
    lane.run(() => {
      signal?.throwIfAborted();
      onRequest?.();
      return task();
    }, priority);
  const various = isVariousArtists(release.artists);
  const accepts = (hit: StoreHit, title: string): boolean =>
    titlesMatch(hit.title, title) &&
    (various ? hit.album !== null && titlesMatch(hit.album, release.title) : artistsMatch(hit.artist, release.artists));

  if (store.searchReleases && !various) {
    const query = searchQuery(release.artists, release.title);
    const hits = await request(() => store.searchReleases!(session, query));
    const album = hits.find((hit) => hit.kind === "album" && accepts(hit, release.title));
    if (album) return { status: "album", url: album.url, tracks: [], trackCount: null };
    logRejects(store, release, query, hits);
  }

  if (store.searchTracks) {
    const found: FoundTrack[] = [];
    const tracks = searchableTracks(release);
    for (const track of tracks) {
      const query = various ? `${release.title} ${track.title}` : searchQuery(release.artists, track.title);
      const hits = await request(() => store.searchTracks!(session, query));
      const hit = hits.find((h) => h.kind === "track" && accepts(h, track.title));
      if (hit) found.push({ position: track.position, title: track.title, url: hit.url });
      else logRejects(store, release, query, hits);
    }
    if (found.length > 0) return { status: "tracks", url: null, tracks: found, trackCount: tracks.length };
    return { status: "none", url: null, tracks: [], trackCount: tracks.length };
  }

  return { status: "none", url: null, tracks: [], trackCount: null };
}

function logRejects(store: DigitalStore, release: CheckableRelease, query: string, hits: StoreHit[]): void {
  const near = hits
    .slice(0, LOGGED_REJECTS)
    .map((hit) => `${hit.artist} - ${hit.title}${hit.album ? ` [${hit.album}]` : ""}`)
    .join(" | ");
  logger.info(`${store.id}: no match for release ${release.id} with "${query}"${near ? `; rejected: ${near}` : ""}`);
}
