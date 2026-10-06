import type {
  DiscogsInventoryPage,
  DiscogsUserProfile,
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

/** Discogs answered 429. */
export class DiscogsRateLimitError extends DiscogsTransientError {}

/** Discogs rejected our token (401/403). Retrying cannot help, so the run fails. */
export class DiscogsAuthError extends Error {}

/** Discogs won't paginate past page 100 of another seller's inventory. Not a token problem. */
export class DiscogsPaginationCapError extends Error {}

function retryAfterMs(res: Response): number | null {
  const seconds = Number(res.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

async function discogsGet<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (process.env.DISCOGS_TOKEN) {
    headers.Authorization = `Discogs token=${process.env.DISCOGS_TOKEN}`;
  }

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
    const body = await res.text();
    if (res.status === 403 && body.includes("Pagination above")) {
      throw new DiscogsPaginationCapError(`Discogs pagination cap for ${path}: ${body}`);
    }
    throw new DiscogsAuthError(`Discogs refused our token (${res.status}) for ${path}: ${body}`);
  }
  if (res.status >= 500) {
    throw new DiscogsTransientError(`Discogs API error ${res.status} for ${path}`);
  }
  if (!res.ok) {
    throw new Error(`Discogs API error ${res.status} for ${path}: ${await res.text()}`);
  }

  return (await res.json()) as T;
}

export function getRelease(releaseId: number) {
  return discogsGet<DiscogsRelease>(`/releases/${releaseId}`);
}

export function getMaster(masterId: number) {
  return discogsGet<DiscogsMaster>(`/masters/${masterId}`);
}

export function getUserProfile(username: string) {
  return discogsGet<DiscogsUserProfile>(`/users/${encodeURIComponent(username)}`);
}

export function getInventory(
  username: string,
  page: number,
  scan: { sort: string; order: string } = { sort: "artist", order: "asc" },
) {
  return discogsGet<DiscogsInventoryPage>(
    `/users/${encodeURIComponent(username)}/inventory?page=${page}&per_page=100&sort=${scan.sort}&sort_order=${scan.order}`,
  );
}

function getMasterVersionsPage(masterId: number, page: number) {
  return discogsGet<DiscogsMasterVersionsResponse>(
    `/masters/${masterId}/versions?page=${page}&per_page=100`,
  );
}

/** Walks every page of /masters/{id}/versions, returns all sibling release ids. */
export async function getAllMasterVersionReleaseIds(masterId: number): Promise<number[]> {
  const ids: number[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const res = await getMasterVersionsPage(masterId, page);
    ids.push(...res.versions.map((v) => v.id));
    totalPages = res.pagination.pages;
    page += 1;
  } while (page <= totalPages);

  return ids;
}
