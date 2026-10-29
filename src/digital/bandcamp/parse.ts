import type { StoreHit } from "../types";

/** The page Bandcamp's bot check answers with instead of the results, with a 200. */
export function isChallengePage(html: string): boolean {
  return /<title>\s*Client Challenge\s*<\/title>/i.test(html) || html.includes("/_fs-ch-");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec: string, hex: string, name: string) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function squash(html: string): string {
  return decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function block(item: string, className: string): string | null {
  const match = new RegExp(`<div class="${className}"[^>]*>([\\s\\S]*?)</div>`).exec(item);
  return match?.[1] ?? null;
}

/**
 * The results on a Bandcamp search page (`bandcamp.com/search`), in the order listed. A result is
 * an `li.searchresult` whose `.heading` holds the title, `.subhead` "from <album> by <artist>"
 * (a track) or "by <artist>" (an album) and `.itemurl` the plain URL, without the tracking
 * parameters the links carry. A result that does not read that way is left out.
 */
export function parseSearchResults(html: string): StoreHit[] {
  const hits: StoreHit[] = [];
  for (const result of html.matchAll(/<li class="searchresult[^>]*>([\s\S]*?)<\/li>/g)) {
    const item = result[1] ?? "";
    const kind = squash(block(item, "itemtype") ?? "").toLowerCase();
    const title = squash(block(item, "heading") ?? "");
    const subhead = squash(block(item, "subhead") ?? "");
    const url = squash(block(item, "itemurl") ?? "");
    if ((kind !== "album" && kind !== "track") || !title || !url) continue;

    // Greedy, so an album called "Stand by Me" is not cut at its own "by".
    const credit = /^(?:from (.+) )?by (.+)$/.exec(subhead);
    if (!credit) continue;
    hits.push({ kind, title, artist: credit[2] ?? "", album: credit[1] ?? null, url });
  }
  return hits;
}
