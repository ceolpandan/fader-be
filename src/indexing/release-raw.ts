import type { DiscogsRelease } from "../types/discogs-api";

/** Keys dropped at the top level of a release response: image URLs and a link to the master's API page. */
const TOP_LEVEL_DROPPED = new Set(["images", "master_url"]);

/** Key dropped at any depth: the API link every nested object carries. */
const DROPPED_EVERYWHERE = "resource_url";

/**
 * The release response as it is stored in `release_raw`: everything Discogs sent except the
 * top-level `images` and `master_url` and every `resource_url`, as JSON text.
 */
export function stripReleaseBody(raw: DiscogsRelease): string {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!TOP_LEVEL_DROPPED.has(key)) body[key] = value;
  }
  return JSON.stringify(stripResourceUrls(body));
}

function stripResourceUrls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripResourceUrls);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== DROPPED_EVERYWHERE) out[key] = stripResourceUrls(child);
  }
  return out;
}
