/**
 * A scrape line as the Discogs search should see it: the line itself, with punctuation and other
 * special characters turned into spaces (apostrophes stay, as they belong to words) and the
 * whitespace collapsed. Nothing is split or reordered, so the search reads it as the shop wrote it.
 */
export function sanitiseSearchQuery(line: string): string {
  return line
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}'’\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
