import type { FacetValueDto } from "../dto/release-list.dto";

export interface FacetRow {
  genres: string[];
  styles: string[];
  formats: { name: string }[];
  country: string | null;
}

function tally(values: Iterable<string>): FacetValueDto[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/**
 * How many of the given release rows carry each genre, style, format name and country, most
 * common first (ties alphabetical). A release counts once per value, whatever the copies.
 */
export function countFacets(rows: FacetRow[]) {
  return {
    genres: tally(rows.flatMap((row) => [...new Set(row.genres)])),
    styles: tally(rows.flatMap((row) => [...new Set(row.styles)])),
    formats: tally(rows.flatMap((row) => [...new Set(row.formats.map((f) => f.name))])),
    countries: tally(rows.flatMap((row) => (row.country ? [row.country] : []))),
  };
}
