import type { FacetValueDto, PriceBucketDto, PriceCurrencyDto } from "../dto/seller.dto";
import type { PriceRange } from "./release-query";

export interface FacetRow {
  genres: string[];
  styles: string[];
  formats: { name: string }[];
  country: string | null;
}

export interface ListingPrice {
  releaseId: number;
  price: number;
  currency: string;
}

/** Up to five boundaries make up to six price buckets. */
const MAX_BOUNDARIES = 5;

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

/** Whether any of a release's listings is in the range and currency. */
export function matchesPrice(listings: ListingPrice[], price: PriceRange): boolean {
  return listings.some(
    (l) =>
      l.currency === price.currency &&
      (price.min === undefined || l.price >= price.min) &&
      (price.max === undefined || l.price <= price.max),
  );
}

/** The currencies the listings are in, each with how many releases have a listing in it, most common first. */
export function countCurrencies(listings: ListingPrice[]): PriceCurrencyDto[] {
  const releasesByCurrency = new Map<string, Set<number>>();
  for (const l of listings) {
    const ids = releasesByCurrency.get(l.currency) ?? new Set<number>();
    ids.add(l.releaseId);
    releasesByCurrency.set(l.currency, ids);
  }
  return [...releasesByCurrency]
    .map(([currency, ids]) => ({ currency, count: ids.size }))
    .sort((a, b) => b.count - a.count || a.currency.localeCompare(b.currency));
}

/** Rounds to the nearest of 1, 2, 5 and 10 times a power of ten. */
function niceNumber(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const candidates = [1, 2, 5, 10].map((m) => m * magnitude);
  return candidates.reduce((best, c) => (Math.abs(c - value) < Math.abs(best - value) ? c : best));
}

/**
 * Price boundaries for a currency, in 1-2-5 steps at the quantiles of each release's cheapest
 * listing, so every bucket holds a similar share of the inventory.
 */
export function priceBoundaries(listings: ListingPrice[], currency: string): number[] {
  const cheapest = new Map<number, number>();
  for (const l of listings) {
    if (l.currency !== currency) continue;
    cheapest.set(l.releaseId, Math.min(cheapest.get(l.releaseId) ?? Infinity, l.price));
  }
  const sorted = [...cheapest.values()].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const boundaries = new Set<number>();
  for (let i = 1; i <= MAX_BOUNDARIES; i++) {
    const quantile = sorted[Math.min(sorted.length - 1, Math.floor((i * sorted.length) / (MAX_BOUNDARIES + 1)))]!;
    if (quantile > 0) boundaries.add(niceNumber(quantile));
  }
  // A boundary at or below the cheapest listing would leave an empty first bucket.
  return [...boundaries].filter((b) => b > sorted[0]!).sort((a, b) => a - b);
}

const cents = (value: number) => Math.round(value * 100) / 100;

/**
 * The price buckets for the given boundaries, with how many of the releases have a listing in each.
 * Ranges are inclusive at both ends like the price filter, so a bucket ends one cent below the
 * next one's start; the first has no lower end and the last no upper end.
 */
export function priceBuckets(
  boundaries: number[],
  listingsByRelease: ListingPrice[][],
  currency: string,
): PriceBucketDto[] {
  const starts: (number | null)[] = [null, ...boundaries];
  return starts.map((min, i) => {
    const next = boundaries[i];
    const max = next === undefined ? null : cents(next - 0.01);
    const range: PriceRange = { min: min ?? undefined, max: max ?? undefined, currency };
    return {
      min,
      max,
      count: listingsByRelease.filter((listings) => matchesPrice(listings, range)).length,
    };
  });
}
