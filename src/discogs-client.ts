import type {
  DiscogsMaster,
  DiscogsMasterVersionsResponse,
  DiscogsRelease,
} from "./types/discogs-api";
import { logger } from "./util/logger";

const DISCOGS_API_BASE = "https://api.discogs.com";
const USER_AGENT = "discogs-fade-backend/0.1 +https://github.com/discogs-fade";

export class DiscogsNotFoundError extends Error {}

/**
 * A Discogs failure worth waiting out: a rate limit, a 5xx or a network error. The queue pauses
 * and retries the same job instead of failing it. `retryAfterMs` is Discogs' `Retry-After`, if sent.
 */
export class DiscogsTransientError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/**
 * Discogs answered 5xx. It may be an outage or just this one release; the queue retries the job
 * a few times at its normal pace, then sets it aside, and pauses only when it keeps happening.
 */
export class DiscogsServerError extends DiscogsTransientError {}

/** Discogs answered 429. */
export class DiscogsRateLimitError extends DiscogsTransientError {}

/** Discogs rejected our token (401/403). Retrying cannot help, so the run fails. */
export class DiscogsAuthError extends Error {}

function retryAfterMs(res: Response): number | null {
  const seconds = Number(res.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** Every request is made with a collector's own personal access token; there is no server-wide one. */
async function discogsGet<T>(path: string, token: string): Promise<T> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT, Authorization: `Discogs token=${token}` };

  logger.request("DISCOGS", "GET", path);
  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(`${DISCOGS_API_BASE}${path}`, { headers });
  } catch (err) {
    throw new DiscogsTransientError(`Discogs request failed for ${path}: ${String(err)}`);
  }
  logger.response("DISCOGS", "GET", path, res.status, Date.now() - start);

  if (res.status === 404) {
    throw new DiscogsNotFoundError(`Discogs resource not found: ${path}`);
  }
  if (res.status === 429) {
    throw new DiscogsRateLimitError(
      `Discogs API error 429 for ${path}: ${await res.text()}`,
      retryAfterMs(res),
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new DiscogsAuthError(
      `Discogs refused our token (${res.status}) for ${path}: ${await res.text()}`,
    );
  }
  if (res.status >= 500) {
    throw new DiscogsServerError(`Discogs API error ${res.status} for ${path}`);
  }
  if (!res.ok) {
    throw new Error(`Discogs API error ${res.status} for ${path}: ${await res.text()}`);
  }

  return (await res.json()) as T;
}

/** Who a personal access token belongs to. Rejects with `DiscogsAuthError` when Discogs does not accept the token. */
export function getIdentity(token: string) {
  return discogsGet<{ id: number; username: string }>("/oauth/identity", token);
}

/** The copies in the collector's collection (Discogs' "All" folder, id 0), duplicates counted. */
export async function getCollectionCount(username: string, token: string): Promise<number> {
  const folder = await discogsGet<{ count: number }>(
    `/users/${encodeURIComponent(username)}/collection/folders/0`,
    token,
  );
  return folder.count;
}

export async function getWantlistCount(username: string, token: string): Promise<number> {
  const wants = await discogsGet<{ pagination: { items: number } }>(
    `/users/${encodeURIComponent(username)}/wants?per_page=1`,
    token,
  );
  return wants.pagination.items;
}

export function getRelease(releaseId: number, token: string) {
  return discogsGet<DiscogsRelease>(`/releases/${releaseId}`, token);
}

export function getMaster(masterId: number, token: string) {
  return discogsGet<DiscogsMaster>(`/masters/${masterId}`, token);
}

function getMasterVersionsPage(masterId: number, page: number, token: string) {
  return discogsGet<DiscogsMasterVersionsResponse>(
    `/masters/${masterId}/versions?page=${page}&per_page=100`,
    token,
  );
}

/**
 * The id of the first release Discogs returns for a free-text search, or null when it finds none.
 * Only releases are asked for (`type=release`), so a master or an artist never comes first.
 */
export async function searchFirstReleaseId(query: string, token: string): Promise<number | null> {
  const res = await discogsGet<{ results?: { id: number; type?: string }[] }>(
    `/database/search?type=release&per_page=1&q=${encodeURIComponent(query)}`,
    token,
  );
  const first = res.results?.find((result) => result.type === undefined || result.type === "release");
  return first ? first.id : null;
}

/** Walks every page of /masters/{id}/versions, returns all sibling release ids. */
export async function getAllMasterVersionReleaseIds(masterId: number, token: string): Promise<number[]> {
  const ids: number[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const res = await getMasterVersionsPage(masterId, page, token);
    ids.push(...res.versions.map((v) => v.id));
    totalPages = res.pagination.pages;
    page += 1;
  } while (page <= totalPages);

  return ids;
}
