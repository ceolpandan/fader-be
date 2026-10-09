import { asc, desc, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Request } from "express";
import { releases } from "../db/schema";

const SORT_FIELDS = ["title", "year", "artist", "format", "rating"] as const;
type SortField = (typeof SORT_FIELDS)[number];
const SORT_OPTIONS = SORT_FIELDS.flatMap((field) => [field, `-${field}`]) as string[];

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

function jsonArrayHasAny(column: SQLiteColumn, values: string[]): SQL {
  return sql`EXISTS (SELECT 1 FROM json_each(${column}) WHERE value IN (${inList(values)}))`;
}

function jsonFormatNameHasAny(column: SQLiteColumn, values: string[]): SQL {
  return sql`EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_extract(value, '$.name') IN (${inList(values)}))`;
}

function jsonArrayHasNone(column: SQLiteColumn, values: string[]): SQL {
  return sql`NOT ${jsonArrayHasAny(column, values)}`;
}

function jsonFormatNameHasNone(column: SQLiteColumn, values: string[]): SQL {
  return sql`NOT ${jsonFormatNameHasAny(column, values)}`;
}

/** The array is non-empty and every value is in the list. */
function jsonArrayOnly(column: SQLiteColumn, values: string[]): SQL {
  return sql`(json_array_length(${column}) > 0 AND NOT EXISTS (SELECT 1 FROM json_each(${column}) WHERE value NOT IN (${inList(values)})))`;
}

function jsonFormatNameOnly(column: SQLiteColumn, values: string[]): SQL {
  return sql`(json_array_length(${column}) > 0 AND NOT EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_extract(value, '$.name') NOT IN (${inList(values)})))`;
}

function sortColumn(field: SortField) {
  switch (field) {
    case "title":
      return releases.title;
    case "year":
      return releases.year;
    case "artist":
      return sql`json_extract(${releases.artists}, '$[0].name')`;
    case "format":
      return sql`json_extract(${releases.formats}, '$[0].name')`;
    case "rating":
      return releases.ratingAverage;
  }
}

/** The paging, filters and sort shared by every endpoint that lists enriched releases. */
export interface ReleaseQuery {
  page: number;
  pageSize: number;
  /** Conditions on `releases` for the filters; AND them with the endpoint's own scope. */
  filters: SQL[];
  /** ORDER BY terms, with the release id as the final tie-break. */
  orderBy: SQL[];
}

function parseOptionalInt(value: unknown, name: string): { value?: number; error?: string } {
  if (value === undefined) return {};
  const parsed = Number(value);
  return Number.isInteger(parsed) ? { value: parsed } : { error: `${name} must be an integer` };
}

/** Reads `page`, `pageSize`, the filters and `sort` from the query string; `error` is the 400 message. */
export function parseReleaseQuery(req: Request): { query: ReleaseQuery } | { error: string } {
  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.pageSize ?? 50);
  if (!Number.isInteger(page) || page < 1) return { error: "page must be a positive integer" };
  if (!Number.isInteger(pageSize) || pageSize < 1) return { error: "pageSize must be a positive integer" };

  const yearMin = parseOptionalInt(req.query.yearMin, "yearMin");
  if (yearMin.error) return { error: yearMin.error };
  const yearMax = parseOptionalInt(req.query.yearMax, "yearMax");
  if (yearMax.error) return { error: yearMax.error };

  const sortParam = (req.query.sort as string | undefined) ?? "title";
  if (!SORT_OPTIONS.includes(sortParam)) {
    return { error: `sort must be one of ${SORT_OPTIONS.join(", ")}` };
  }
  const isDescending = sortParam.startsWith("-");
  const sortField = (isDescending ? sortParam.slice(1) : sortParam) as SortField;

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
  const noLinks = req.query.noLinks;
  if (noLinks !== undefined && noLinks !== "only" && noLinks !== "exclude") {
    return { error: "noLinks must be one of only, exclude" };
  }

  const filters: SQL[] = [];
  if (genre.length > 0) filters.push(jsonArrayHasAny(releases.genres, genre));
  if (style.length > 0) filters.push(jsonArrayHasAny(releases.styles, style));
  if (format.length > 0) filters.push(jsonFormatNameHasAny(releases.formats, format));
  if (onlyGenre.length > 0) filters.push(jsonArrayOnly(releases.genres, onlyGenre));
  if (onlyStyle.length > 0) filters.push(jsonArrayOnly(releases.styles, onlyStyle));
  if (onlyFormat.length > 0) filters.push(jsonFormatNameOnly(releases.formats, onlyFormat));
  if (excludeGenre.length > 0) filters.push(jsonArrayHasNone(releases.genres, excludeGenre));
  if (excludeStyle.length > 0) filters.push(jsonArrayHasNone(releases.styles, excludeStyle));
  if (excludeFormat.length > 0) filters.push(jsonFormatNameHasNone(releases.formats, excludeFormat));
  if (country.length > 0) filters.push(inArray(releases.country, country));
  // A release has no links when it has no video links.
  if (noLinks === "only") filters.push(sql`json_array_length(${releases.videos}) = 0`);
  if (noLinks === "exclude") filters.push(sql`json_array_length(${releases.videos}) > 0`);
  if (yearMin.value !== undefined) filters.push(gte(releases.year, yearMin.value));
  if (yearMax.value !== undefined) filters.push(lte(releases.year, yearMax.value));

  const orderExpr = sortColumn(sortField);
  // Unrated releases are noise at either end of a rating sort, so they always go last.
  const nullsLast = sortField === "rating" ? [sql`${orderExpr} IS NULL`] : [];
  const orderBy = [...nullsLast, isDescending ? desc(orderExpr) : asc(orderExpr), sql`${releases.id}`];

  return { query: { page, pageSize, filters, orderBy } };
}

/** Distinct genres, styles, format names and countries of the given release rows, sorted. */
export function collectFacets(
  rows: { genres: string[]; styles: string[]; formats: { name: string }[]; country: string | null }[],
) {
  const genres = new Set<string>();
  const styles = new Set<string>();
  const formats = new Set<string>();
  const countries = new Set<string>();
  for (const row of rows) {
    for (const g of row.genres) genres.add(g);
    for (const s of row.styles) styles.add(s);
    for (const f of row.formats) formats.add(f.name);
    if (row.country) countries.add(row.country);
  }
  return {
    genres: [...genres].sort(),
    styles: [...styles].sort(),
    formats: [...formats].sort(),
    countries: [...countries].sort(),
  };
}
