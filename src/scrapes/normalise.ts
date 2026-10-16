/**
 * Reduces an artist or title to what two spellings of it share: no case, accents or punctuation,
 * "&" read as "and", no leading "The" and no Discogs disambiguation number ("Artist (2)").
 */
export function normalise(text: string): string {
  const reduced = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return reduced.replace(/^the /, "");
}

/** A line is `Artist - Title`; the first " - " splits it, so a title may hold further dashes. */
export function splitLine(line: string): { artist: string; title: string } | null {
  const at = line.indexOf(" - ");
  if (at <= 0) return null;
  const artist = line.slice(0, at).trim();
  const title = line.slice(at + 3).trim();
  return artist && title ? { artist, title } : null;
}

/** The non-blank lines of an upload, trimmed, each kept once in file order. */
export function parseLines(text: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }
  return lines;
}
