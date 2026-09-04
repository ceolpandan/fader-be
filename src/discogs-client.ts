import type {
  DiscogsInventoryPage,
  DiscogsMaster,
  DiscogsMasterVersionsResponse,
  DiscogsRelease,
} from "./types/discogs-api";

const DISCOGS_API_BASE = "https://api.discogs.com";
const USER_AGENT = "discogs-fade-backend/0.1 +https://github.com/discogs-fade";

export class DiscogsNotFoundError extends Error {}

async function discogsGet<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (process.env.DISCOGS_TOKEN) {
    headers.Authorization = `Discogs token=${process.env.DISCOGS_TOKEN}`;
  }

  const res = await fetch(`${DISCOGS_API_BASE}${path}`, { headers });

  if (res.status === 404) {
    throw new DiscogsNotFoundError(`Discogs resource not found: ${path}`);
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

export function getInventory(username: string, page: number) {
  return discogsGet<DiscogsInventoryPage>(
    `/users/${encodeURIComponent(username)}/inventory?page=${page}&per_page=100`,
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
