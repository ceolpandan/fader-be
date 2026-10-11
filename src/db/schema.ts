import { sql } from "drizzle-orm";
import { sqliteTable, integer, real, text, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export interface ReleaseFormat {
  name: string;
  descriptions: string[];
}

export interface ReleaseArtistStub {
  id: number;
  name: string;
}

export interface ReleaseTrack {
  position: string;
  title: string;
  duration?: string;
}

export interface ReleaseLabel {
  id: number;
  name: string;
  catno?: string;
}

/** A video as the Discogs dump lists it, without its description. */
export interface ReleaseVideo {
  src: string;
  title?: string;
  duration?: number;
}

/**
 * The Electronic catalogue, filled from the Discogs data dump by `npm run db:import`. The side
 * tables below are kept in step with `genres`, `styles` and `formats` by triggers (migration
 * `0021`), and `track_count`, `artist_sort` and `format_sort` are generated, so writing a row is
 * enough. Indexes serve the Explore sorts and filters (fader-ui#103, fader-ui#105). The rating,
 * `enriched_at` and `missing_at` columns are only ever written by an enrichment run, and the
 * dump import keeps existing rows as they are (`0007-catalogue-from-data-dump.md`).
 */
export const releases = sqliteTable(
  "releases",
  {
    id: integer("id").primaryKey(),
    title: text("title").notNull(),
    year: integer("year"),
    country: text("country"),
    genres: text("genres", { mode: "json" }).$type<string[]>().notNull(),
    styles: text("styles", { mode: "json" }).$type<string[]>().notNull(),
    formats: text("formats", { mode: "json" }).$type<ReleaseFormat[]>().notNull(),
    masterId: integer("master_id"),
    labels: text("labels", { mode: "json" }).$type<ReleaseLabel[]>().notNull().default([]),
    artists: text("artists", { mode: "json" }).$type<ReleaseArtistStub[]>().notNull(),
    tracklist: text("tracklist", { mode: "json" }).$type<ReleaseTrack[]>().notNull().default([]),
    videos: text("videos", { mode: "json" }).$type<ReleaseVideo[]>().notNull().default([]),
    /** Discogs community rating, from an enrichment run (fader-ui#109); null until enriched. */
    ratingAverage: real("rating_average"),
    ratingCount: integer("rating_count"),
    /** When an enrichment run last refreshed the row from the Discogs API. */
    enrichedAt: integer("enriched_at", { mode: "timestamp" }),
    /** When an enrichment run found Discogs no longer has the release; Explore hides it. */
    missingAt: integer("missing_at", { mode: "timestamp" }),
    trackCount: integer("track_count").generatedAlwaysAs(sql`json_array_length(tracklist)`, { mode: "virtual" }),
    artistSort: text("artist_sort").generatedAlwaysAs(sql`json_extract(artists, '$[0].name')`, { mode: "virtual" }),
    formatSort: text("format_sort").generatedAlwaysAs(sql`json_extract(formats, '$[0].name')`, { mode: "virtual" }),
  },
  (table) => [
    index("releases_master_id_idx").on(table.masterId),
    index("releases_title_idx").on(table.title, table.id),
    index("releases_year_idx").on(table.year, table.id),
    index("releases_artist_sort_idx").on(table.artistSort, table.id),
    index("releases_format_sort_idx").on(table.formatSort, table.id),
    // Serves the track-count sort, which puts releases with no tracks last.
    index("releases_track_count_idx").on(sql`(${table.trackCount} = 0)`, sql`${table.trackCount} DESC`, table.id),
    index("releases_country_idx").on(table.country, table.id),
    // Serves the rating sort, which puts releases that were never enriched last.
    index("releases_rating_idx").on(sql`(${table.ratingAverage} IS NULL)`, sql`${table.ratingAverage} DESC`, table.id),
  ],
);

export const releaseGenres = sqliteTable(
  "release_genres",
  { releaseId: integer("release_id").notNull(), genre: text("genre").notNull() },
  (table) => [
    uniqueIndex("release_genres_genre_idx").on(table.genre, table.releaseId),
    index("release_genres_release_idx").on(table.releaseId, table.genre),
  ],
);

export const releaseStyles = sqliteTable(
  "release_styles",
  { releaseId: integer("release_id").notNull(), style: text("style").notNull() },
  (table) => [
    uniqueIndex("release_styles_style_idx").on(table.style, table.releaseId),
    index("release_styles_release_idx").on(table.releaseId, table.style),
  ],
);

/** One row per format name (Vinyl, CD, File...) a release has. */
export const releaseFormats = sqliteTable(
  "release_formats",
  { releaseId: integer("release_id").notNull(), format: text("format").notNull() },
  (table) => [
    uniqueIndex("release_formats_format_idx").on(table.format, table.releaseId),
    index("release_formats_release_idx").on(table.releaseId, table.format),
  ],
);

export const FILTER_OPTION_KINDS = ["genre", "style", "format", "country"] as const;
export type FilterOptionKind = (typeof FILTER_OPTION_KINDS)[number];

/**
 * The values the filter dialog offers for each category, most common first (`position`). Built
 * from the releases when the catalogue is imported, so the dialog needs no counts.
 */
export const filterOptions = sqliteTable(
  "filter_options",
  {
    kind: text("kind").$type<FilterOptionKind>().notNull(),
    value: text("value").notNull(),
    position: integer("position").notNull(),
  },
  (table) => [primaryKey({ columns: [table.kind, table.value] })],
);

export type QueueJobType = "fade_lookup" | "release_detail";
export type QueueJobStatus = "pending" | "processing" | "done" | "failed";

/** Resolves a fade against Discogs: a release fade finds its master, a master fade fetches its versions. */
export interface FadeLookupPayload {
  uid: string;
  kind: FadeKind;
  id: number;
}

/** Fetches one release from Discogs for its rating (enrichment, fader-ui#109). */
export interface ReleaseDetailPayload {
  uid: string;
  releaseId: number;
  /** An inline refresh: a Discogs 404 marks the release missing at once instead of after retries. */
  once?: boolean;
}

export interface QueueJobPayloadMap {
  fade_lookup: FadeLookupPayload;
  release_detail: ReleaseDetailPayload;
}

export const discogsQueueJobs = sqliteTable("discogs_queue_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** The collector whose Discogs token the job uses; each collector has their own lane (`payload.uid`). */
  uid: text("uid").notNull().default(""),
  runId: text("run_id").notNull(),
  type: text("type").$type<QueueJobType>().notNull(),
  payload: text("payload", { mode: "json" })
    .$type<FadeLookupPayload | ReleaseDetailPayload>()
    .notNull(),
  status: text("status").$type<QueueJobStatus>().notNull().default("pending"),
  priority: integer("priority").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export type FadeKind = "master" | "release";

export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = "dark";

/** A user's settings, one row per user once they change any; a missing row means the defaults. */
export const userSettings = sqliteTable("user_settings", {
  uid: text("uid").primaryKey(),
  theme: text("theme").$type<Theme>().notNull().default(DEFAULT_THEME),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/**
 * A filter a collector saved on Explore: `query` is the Explore URL query without `page` (sort
 * kept), so applying it is navigating to `/explore?<query>`. One row per collector and query.
 */
export const savedFilters = sqliteTable(
  "saved_filters",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    uid: text("uid").notNull(),
    name: text("name").notNull(),
    query: text("query").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [uniqueIndex("saved_filters_uid_query_idx").on(table.uid, table.query)],
);

/**
 * A collector's Discogs personal access token, encrypted (`util/token-crypto.ts`). Write-only:
 * no endpoint returns it. `username` is who Discogs said it belongs to when it was saved.
 */
export const discogsTokens = sqliteTable("discogs_tokens", {
  uid: text("uid").primaryKey(),
  tokenEncrypted: text("token_encrypted").notNull(),
  username: text("username").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

/** What a user faded: a master (hides every version under it) or a release without a master. */
export const fades = sqliteTable(
  "fades",
  {
    uid: text("uid").notNull(),
    kind: text("kind").$type<FadeKind>().notNull(),
    id: integer("id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    lookupStatus: text("lookup_status").$type<FadeLookupStatus>().notNull().default("done"),
    /** What Discogs called it, kept from the lookup so an unindexed fade can still be shown. */
    title: text("title"),
    artists: text("artists", { mode: "json" }).$type<ReleaseArtistStub[]>(),
  },
  (table) => [primaryKey({ columns: [table.uid, table.kind, table.id] })],
);

/**
 * Where a fade stands with Discogs: `pending` until its master and versions are known, `done`
 * once they are, `failed` when Discogs can't resolve it (the fade stays; fading again retries).
 */
export type FadeLookupStatus = "pending" | "done" | "failed";

/** The release ids under a master, as Discogs lists them. Shared by every collector. */
export const masterVersions = sqliteTable(
  "master_versions",
  {
    masterId: integer("master_id").notNull(),
    releaseId: integer("release_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.masterId, table.releaseId] }),
    index("master_versions_release_idx").on(table.releaseId),
  ],
);

export type EnrichmentRunStatus = "running" | "done" | "cancelled" | "failed";

/**
 * A collector's enrichment run (fader-ui#109): the releases an Explore filter shows, fetched from
 * Discogs for their rating. The run id is the queue `run_id` of its jobs, whose states give the
 * progress. Only the latest run per collector is kept. `total` is the jobs queued, `skipped` the
 * matching releases left alone (already enriched, or already queued by another run).
 */
export const enrichmentRuns = sqliteTable("enrichment_runs", {
  id: text("id").primaryKey(),
  uid: text("uid").notNull(),
  /** The Explore query the run was started from, without `page`. */
  query: text("query").notNull(),
  fresh: integer("fresh", { mode: "boolean" }).notNull(),
  status: text("status").$type<EnrichmentRunStatus>().notNull(),
  total: integer("total").notNull(),
  skipped: integer("skipped").notNull(),
  errorMessage: text("error_message"),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
});

/** The releases a run found Discogs no longer has. */
export const enrichmentNotFound = sqliteTable(
  "enrichment_not_found",
  { runId: text("run_id").notNull(), releaseId: integer("release_id").notNull() },
  (table) => [primaryKey({ columns: [table.runId, table.releaseId] })],
);
