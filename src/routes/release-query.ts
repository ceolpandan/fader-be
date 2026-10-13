import { asc, desc, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { Request } from "express";
import { DEFAULT_RARITY_HAVE_MAX, releaseFormats, releaseGenres, releaseStyles, releases } from "../db/schema";

const SORT_FIELDS = ["title", "year", "artist", "format", "rating", "tracks", "versions"] as const;
type SortField = (typeof SORT_FIELDS)[number];
// Rarity only has a descending order: the rarest releases first.
const SORT_OPTIONS = [...SORT_FIELDS.flatMap((field) => [field, `-${field}`]), "-rarity"] as string[];

function parseCommaSeparated(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function inList(values: string[]): SQL {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

/** The side tables behind the genre, style and format filters; each holds one row per value a release has. */
const SIDE_TABLES = {
  genre: { table: releaseGenres, release: releaseGenres.releaseId, value: releaseGenres.genre },
  style: { table: releaseStyles, release: releaseStyles.releaseId, value: releaseStyles.style },
  format: { table: releaseFormats, release: releaseFormats.releaseId, value: releaseFormats.format },
};
type SideTable = keyof typeof SIDE_TABLES;

function sideRow(kind: SideTable, extra: SQL): SQL {
  const side = SIDE_TABLES[kind];
  return sql`SELECT 1 FROM ${side.table} WHERE ${side.release} = ${releases.id} AND ${extra}`;
}

function hasAny(kind: SideTable, values: string[]): SQL {
  return sql`EXISTS (${sideRow(kind, sql`${SIDE_TABLES[kind].value} IN (${inList(values)})`)})`;
}

function hasNone(kind: SideTable, values: string[]): SQL {
  return sql`NOT ${hasAny(kind, values)}`;
}

/** The release has at least one value and every value is in the list. */
function hasOnly(kind: SideTable, values: string[]): SQL {
  const side = SIDE_TABLES[kind];
  return sql`(EXISTS (${sideRow(kind, sql`1`)}) AND NOT EXISTS (${sideRow(kind, sql`${side.value} NOT IN (${inList(values)})`)}))`;
}

/** The release has every style in the combination. */
function hasAllStyles(styles: string[]): SQL {
  const each = styles.map((v) => sql`EXISTS (${sideRow("style", sql`${releaseStyles.style} = ${v}`)})`);
  return sql`(${sql.join(each, sql` AND `)})`;
}

/** The release has exactly the styles of the combination: every one of them and no other. */
function hasExactlyStyles(styles: string[]): SQL {
  return sql`(${hasAllStyles(styles)} AND ${hasOnly("style", styles)})`;
}

/**
 * The combinations condition: the release matches at least one `include` combination, at least
 * one `only` combination, and none of the `exclude` ones. Each group that is given must hold.
 */
function styleCombinationsFilter(groups: { include: string[][]; only: string[][]; exclude: string[][] }): SQL | null {
  const conditions: SQL[] = [];
  if (groups.include.length > 0) conditions.push(sql`(${sql.join(groups.include.map(hasAllStyles), sql` OR `)})`);
  if (groups.only.length > 0) conditions.push(sql`(${sql.join(groups.only.map(hasExactlyStyles), sql` OR `)})`);
  for (const styles of groups.exclude) conditions.push(sql`NOT ${hasAllStyles(styles)}`);
  return conditions.length > 0 ? sql`(${sql.join(conditions, sql` AND `)})` : null;
}

/** Each `styleCombo` occurrence as a list of styles; empty ones dropped, identical ones (in any order) deduped. */
function parseStyleCombinations(value: unknown): string[][] {
  const occurrences = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const combinations: string[][] = [];
  for (const occurrence of occurrences) {
    const styles = [...new Set(parseCommaSeparated(occurrence))];
    if (styles.length === 0) continue;
    const key = JSON.stringify([...styles].sort());
    if (seen.has(key)) continue;
    seen.add(key);
    combinations.push(styles);
  }
  return combinations;
}

const MAX_SEARCH_LENGTH = 200;

/** A LIKE pattern matching `term` anywhere, with the wildcard characters taken literally. */
function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

/**
 * Every word of the search is in the title or in one of the artist names (SQLite's LIKE
 * ignores ASCII case).
 */
function searchFilter(text: string): SQL {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const each = words.map((word) => {
    const pattern = containsPattern(word);
    return sql`(${releases.title} LIKE ${pattern} ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_each(${releases.artists}) WHERE json_extract(value, '$.name') LIKE ${pattern} ESCAPE '\\'))`;
  });
  return sql`(${sql.join(each, sql` AND `)})`;
}

const TRACK_COUNT_OPTIONS = ["1", "2", "3", "4", "5", "6", "7+"];

/** The tracklist length is one of the counts; "7+" stands for seven or more. */
function trackCountFilter(values: string[]): SQL {
  const length = releases.trackCount;
  const exact = values.filter((v) => v !== "7+").map(Number);
  const conditions: SQL[] = [];
  if (exact.length > 0) conditions.push(sql`${length} IN (${sql.join(exact.map((n) => sql`${n}`), sql`, `)})`);
  if (values.includes("7+")) conditions.push(sql`${length} >= 7`);
  return sql`(${sql.join(conditions, sql` OR `)})`;
}

function sortColumn(field: SortField) {
  switch (field) {
    case "title":
      return releases.title;
    case "year":
      return releases.year;
    case "artist":
      return releases.artistSort;
    case "format":
      return releases.formatSort;
    case "rating":
      return releases.ratingAverage;
    case "tracks":
      return releases.trackCount;
    case "versions":
      return releases.versionCount;
  }
}

/** The paging, filters and sort shared by every endpoint that lists releases. */
export interface ReleaseQuery {
  page: number;
  pageSize: number;
  /** Conditions on `releases` for the filters; AND them with the endpoint's own scope. */
  filters: SQL[];
  /**
   * The style combinations condition, when `styleCombo` is given. Kept out of `filters` so the
   * facets, whose counts ignore combinations, don't pick it up; the listing endpoints AND it in.
   */
  styleCombinations: SQL | null;
  /** ORDER BY terms, with the release id as the final tie-break. */
  orderBy: SQL[];
}

function parseOptionalInt(value: unknown, name: string): { value?: number; error?: string } {
  if (value === undefined) return {};
  const parsed = Number(value);
  return Number.isInteger(parsed) ? { value: parsed } : { error: `${name} must be an integer` };
}

function parseOptionalCount(value: unknown, name: string): { value?: number; error?: string } {
  const parsed = parseOptionalInt(value, name);
  if (parsed.error || (parsed.value !== undefined && parsed.value < 0)) return { error: `${name} must be a non-negative integer` };
  return parsed;
}

function parseOptionalRatio(value: unknown, name: string): { value?: number; error?: string } {
  if (value === undefined) return {};
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? { value: parsed } : { error: `${name} must be a positive number` };
}

function parseOptionalRating(value: unknown, name: string): { value?: number; error?: string } {
  if (value === undefined) return {};
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 5 ? { value: parsed } : { error: `${name} must be a number from 0 to 5` };
}

/** Reads `page`, `pageSize`, the filters and `sort` from the query string; `error` is the 400 message. */
export function parseReleaseQuery(
  req: Pick<Request, "query">,
  /** The user's rarity ceiling: releases with more haves are unranked by `sort=-rarity`. */
  rarityHaveMax = DEFAULT_RARITY_HAVE_MAX,
): { query: ReleaseQuery } | { error: string } {
  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.pageSize ?? 50);
  if (!Number.isInteger(page) || page < 1) return { error: "page must be a positive integer" };
  if (!Number.isInteger(pageSize) || pageSize < 1) return { error: "pageSize must be a positive integer" };

  const yearMin = parseOptionalInt(req.query.yearMin, "yearMin");
  if (yearMin.error) return { error: yearMin.error };
  const yearMax = parseOptionalInt(req.query.yearMax, "yearMax");
  if (yearMax.error) return { error: yearMax.error };

  const ratingCountMin = parseOptionalCount(req.query.ratingCountMin, "ratingCountMin");
  if (ratingCountMin.error) return { error: ratingCountMin.error };

  const ratingMin = parseOptionalRating(req.query.ratingMin, "ratingMin");
  if (ratingMin.error) return { error: ratingMin.error };

  const haveMax = parseOptionalCount(req.query.haveMax, "haveMax");
  if (haveMax.error) return { error: haveMax.error };
  const wantMin = parseOptionalCount(req.query.wantMin, "wantMin");
  if (wantMin.error) return { error: wantMin.error };
  const wantRatioMin = parseOptionalRatio(req.query.wantRatioMin, "wantRatioMin");
  if (wantRatioMin.error) return { error: wantRatioMin.error };

  const sortParam =(req.query.sort as string | undefined) ?? "title";
  if (!SORT_OPTIONS.includes(sortParam)) {
    return { error: `sort must be one of ${SORT_OPTIONS.join(", ")}` };
  }
  const isDescending = sortParam.startsWith("-");
  const sortField = (isDescending ? sortParam.slice(1) : sortParam) as SortField | "rarity";

  const genre = parseCommaSeparated(req.query.genre);
  const style = parseCommaSeparated(req.query.style);
  const format = parseCommaSeparated(req.query.format);
  const onlyGenre = parseCommaSeparated(req.query.onlyGenre);
  const onlyStyle = parseCommaSeparated(req.query.onlyStyle);
  const onlyFormat = parseCommaSeparated(req.query.onlyFormat);
  const excludeGenre = parseCommaSeparated(req.query.excludeGenre);
  const excludeStyle = parseCommaSeparated(req.query.excludeStyle);
  const excludeFormat = parseCommaSeparated(req.query.excludeFormat);
  const country = parseCommaSeparated(req.query.country);
  const tracks = parseCommaSeparated(req.query.tracks);
  if (!tracks.every((t) => TRACK_COUNT_OPTIONS.includes(t))) {
    return { error: `tracks must be a comma-separated list of ${TRACK_COUNT_OPTIONS.join(", ")}` };
  }
  const noLinks = req.query.noLinks;
  if (noLinks !== undefined && noLinks !== "only" && noLinks !== "exclude") {
    return { error: "noLinks must be one of only, exclude" };
  }

  const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (search.length > MAX_SEARCH_LENGTH) return { error: `q must be at most ${MAX_SEARCH_LENGTH} characters` };

  const filters: SQL[] = [];
  if (search.length > 0) filters.push(searchFilter(search));
  if (genre.length > 0) filters.push(hasAny("genre", genre));
  if (style.length > 0) filters.push(hasAny("style", style));
  if (format.length > 0) filters.push(hasAny("format", format));
  if (onlyGenre.length > 0) filters.push(hasOnly("genre", onlyGenre));
  if (onlyStyle.length > 0) filters.push(hasOnly("style", onlyStyle));
  if (onlyFormat.length > 0) filters.push(hasOnly("format", onlyFormat));
  if (excludeGenre.length > 0) filters.push(hasNone("genre", excludeGenre));
  if (excludeStyle.length > 0) filters.push(hasNone("style", excludeStyle));
  if (excludeFormat.length > 0) filters.push(hasNone("format", excludeFormat));
  if (country.length > 0) filters.push(inArray(releases.country, country));
  if (tracks.length > 0) filters.push(trackCountFilter(tracks));
  // A release has no links when it has no video links.
  if (noLinks === "only") filters.push(sql`json_array_length(${releases.videos}) = 0`);
  if (noLinks === "exclude") filters.push(sql`json_array_length(${releases.videos}) > 0`);
  if (yearMin.value !== undefined) filters.push(gte(releases.year, yearMin.value));
  if (yearMax.value !== undefined) filters.push(lte(releases.year, yearMax.value));
  // The rating count is only known for enriched releases, so this leaves out the rest.
  if (ratingCountMin.value !== undefined) filters.push(gte(releases.ratingCount, ratingCountMin.value));
  // The average rating is only known for enriched releases, so this leaves out the rest.
  if (ratingMin.value !== undefined) filters.push(gte(releases.ratingAverage, ratingMin.value));
  // Haves and wants are only known for enriched releases, so any of these leaves out the rest.
  if (haveMax.value !== undefined || wantMin.value !== undefined || wantRatioMin.value !== undefined) {
    filters.push(sql`${releases.haveCount} IS NOT NULL`, sql`${releases.wantCount} IS NOT NULL`);
  }
  if (haveMax.value !== undefined) filters.push(lte(releases.haveCount, haveMax.value));
  if (wantMin.value !== undefined) filters.push(gte(releases.wantCount, wantMin.value));
  // Wants per have; a release nobody has counts as one have, so it never divides by zero.
  if (wantRatioMin.value !== undefined) {
    filters.push(sql`${releases.wantCount} >= ${wantRatioMin.value} * MAX(${releases.haveCount}, 1)`);
  }

  const styleCombinations = styleCombinationsFilter({
    include: parseStyleCombinations(req.query.styleCombo),
    only: parseStyleCombinations(req.query.onlyStyleCombo),
    exclude: parseStyleCombinations(req.query.excludeStyleCombo),
  });

  if (sortField === "rarity") {
    // Wants per have, a release nobody has counting as one have. Releases without counts, or with
    // more haves than the ceiling, have no rank and go last; ties go to the one more wanted.
    const unranked = sql`(${releases.haveCount} IS NULL OR ${releases.wantCount} IS NULL OR ${releases.haveCount} > ${rarityHaveMax})`;
    const ratio = sql`${releases.wantCount} * 1.0 / MAX(${releases.haveCount}, 1)`;
    const orderBy = [unranked, sql`${ratio} DESC`, desc(releases.wantCount), asc(releases.title), sql`${releases.id}`];
    return { query: { page, pageSize, filters, styleCombinations, orderBy } };
  }

  const orderExpr = sortColumn(sortField);
  // Releases never enriched have no rating, and one with no tracklist has no known track count: both go last.
  const nullsLast =
    sortField === "rating"
      ? [sql`${releases.ratingAverage} IS NULL`]
      : sortField === "tracks"
        ? [sql`${releases.trackCount} = 0`]
        : [];
  const orderBy = [...nullsLast, isDescending ? desc(orderExpr) : asc(orderExpr), sql`${releases.id}`];

  return { query: { page, pageSize, filters, styleCombinations, orderBy } };
}
