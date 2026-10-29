import fs from "node:fs";
import path from "node:path";
import type { DiscogsRelease } from "../../types/discogs-api";

/**
 * Real `GET /releases/{id}` responses (fader-ui#153), each with the output `release_raw` should
 * hold. `raw` is committed as Discogs sent it; `stripped` was reviewed by hand once.
 *  - 1894284: a white label promo 12".
 *  - 1096326: a limited edition 12".
 *  - 4000: has a master, labels, companies, credits (also per track), identifiers and contributors.
 */
export const RELEASE_FIXTURE_IDS = [1894284, 1096326, 4000] as const;

export function loadReleaseFixture(id: number): { raw: DiscogsRelease; stripped: Record<string, unknown> } {
  const read = (kind: "raw" | "stripped") =>
    JSON.parse(fs.readFileSync(path.join(__dirname, `release-${id}.${kind}.json`), "utf8")) as unknown;
  return { raw: read("raw") as DiscogsRelease, stripped: read("stripped") as Record<string, unknown> };
}
