import { normalise } from "../scrapes/normalise";
import type { ReleaseArtistStub } from "../db/schema";

/** A mix name stores add and Discogs leaves out: "Title (Original Mix)" is "Title". */
const ORIGINAL_MIX = /\s*[([]\s*original(?:\s+mix)?\s*[)\]]\s*$/i;

/** Credits that join artists: "A feat. B", "A ft B", "A, B" and "A & B" are all "A and B". */
const FEATURING = /\b(?:featuring|feat|ft)\b\.?/gi;

/** Discogs credits a compilation to this artist; it says nothing about who made a track. */
const VARIOUS = "various";

function reduce(text: string): string {
  return normalise(text.replace(FEATURING, " and ").replace(/,/g, " and "));
}

/** Titles match when equal after `normalise`, ignoring a trailing "(Original Mix)" or "(Original)". */
export function titlesMatch(a: string, b: string): boolean {
  const left = reduce(a.replace(ORIGINAL_MIX, ""));
  return left !== "" && left === reduce(b.replace(ORIGINAL_MIX, ""));
}

/**
 * An artist as a store lists it matches when it is one of the release's artists, all of them
 * joined ("A and B"), or each of the "and"-joined names in it is one of them.
 */
export function artistsMatch(storeArtist: string, releaseArtists: ReleaseArtistStub[]): boolean {
  const wanted = reduce(storeArtist);
  if (wanted === "") return false;
  const names = releaseArtists.map((artist) => reduce(artist.name));
  if (names.includes(wanted) || names.join(" and ") === wanted) return true;
  const parts = wanted.split(" and ").filter(Boolean);
  return parts.length > 1 && parts.every((part) => names.includes(part));
}

export function isVariousArtists(artists: ReleaseArtistStub[]): boolean {
  return artists.length > 0 && artists.every((artist) => reduce(artist.name) === VARIOUS);
}

/** The words a store is searched with: the first credited artist, then the title. */
export function searchQuery(artists: ReleaseArtistStub[], title: string): string {
  const artist = artists.find((a) => reduce(a.name) !== VARIOUS)?.name;
  return [artist, title].filter(Boolean).join(" ");
}
