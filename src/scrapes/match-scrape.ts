import { and, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { isNotMissing } from "../db/missing";
import { releases, type ReleaseArtistStub } from "../db/schema";
import { normalise, splitLine } from "./normalise";

export interface ScrapeMatch {
  /** Every release a line matched, once, in ascending id order. */
  releaseIds: number[];
  /** The lines that matched nothing, with their position in the upload. */
  unmatched: { position: number; line: string }[];
}

/** Titles read per query while scanning the title index; the scan yields to the server between pages. */
const TITLE_PAGE_SIZE = 100_000;
const ARTIST_CHUNK_SIZE = 500;

const yieldToServer = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Wanted {
  position: number;
  artist: string;
}

/** A credit can be a single artist or the whole credit read as "A and B". */
function artistKeys(artists: ReleaseArtistStub[]): Set<string> {
  const keys = new Set(artists.map((artist) => normalise(artist.name)));
  if (artists.length > 1) keys.add(artists.map((artist) => normalise(artist.name)).join(" and "));
  return keys;
}

/**
 * Matches `Artist - Title` lines to releases when both the artist and the title are the same after
 * normalising. A line that fits several pressings takes all of them. The titles come from one scan
 * of the title index (about six seconds for five million releases), since the catalogue has no
 * normalised column to look a title up by.
 */
export async function matchScrapeLines(db: Db, lines: string[]): Promise<ScrapeMatch> {
  const byTitle = new Map<string, Wanted[]>();
  lines.forEach((line, position) => {
    const parts = splitLine(line);
    if (!parts) return;
    const key = normalise(parts.title);
    if (!key) return;
    const wanted = byTitle.get(key) ?? [];
    wanted.push({ position, artist: normalise(parts.artist) });
    byTitle.set(key, wanted);
  });

  const candidates = new Map<number, string>();
  let after: { title: string; id: number } | null = null;
  for (;;) {
    const page: { id: number; title: string }[] = after
      ? db.all(
          sql`SELECT id, title FROM releases WHERE (title, id) > (${after.title}, ${after.id}) ORDER BY title, id LIMIT ${TITLE_PAGE_SIZE}`,
        )
      : db.all(sql`SELECT id, title FROM releases ORDER BY title, id LIMIT ${TITLE_PAGE_SIZE}`);
    for (const row of page) {
      const key = normalise(row.title);
      if (byTitle.has(key)) candidates.set(row.id, key);
    }
    const last = page[page.length - 1];
    if (!last || page.length < TITLE_PAGE_SIZE) break;
    after = { title: last.title, id: last.id };
    await yieldToServer();
  }

  const matchedLines = new Set<number>();
  const releaseIds = new Set<number>();
  const ids = [...candidates.keys()];
  for (let from = 0; from < ids.length; from += ARTIST_CHUNK_SIZE) {
    const rows = db
      .select({ id: releases.id, artists: releases.artists })
      .from(releases)
      // A release Discogs no longer has is hidden by Explore, so a line only it fits stays unmatched.
      .where(and(inArray(releases.id, ids.slice(from, from + ARTIST_CHUNK_SIZE)), isNotMissing))
      .all();
    for (const row of rows) {
      const keys = artistKeys(row.artists);
      for (const wanted of byTitle.get(candidates.get(row.id)!) ?? []) {
        if (!keys.has(wanted.artist)) continue;
        matchedLines.add(wanted.position);
        releaseIds.add(row.id);
      }
    }
  }

  const unmatched = lines.flatMap((line, position) => (matchedLines.has(position) ? [] : [{ position, line }]));
  return { releaseIds: [...releaseIds].sort((a, b) => a - b), unmatched };
}
