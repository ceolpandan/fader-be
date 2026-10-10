import { sqliteTable, integer, text, real, primaryKey, index } from "drizzle-orm/sqlite-core";

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

export interface ReleaseVideo {
  uri: string;
  title?: string;
  duration?: number;
}

export const releases = sqliteTable("releases", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
  year: integer("year"),
  country: text("country"),
  genres: text("genres", { mode: "json" }).$type<string[]>().notNull(),
  styles: text("styles", { mode: "json" }).$type<string[]>().notNull(),
  formats: text("formats", { mode: "json" }).$type<ReleaseFormat[]>().notNull(),
  masterId: integer("master_id"),
  thumb: text("thumb"),
  ratingAverage: real("rating_average"),
  ratingCount: integer("rating_count"),
  haves: integer("haves"),
  wants: integer("wants"),
  labelIds: text("label_ids", { mode: "json" }).$type<number[]>().notNull(),
  artists: text("artists", { mode: "json" }).$type<ReleaseArtistStub[]>().notNull(),
  tracklist: text("tracklist", { mode: "json" }).$type<ReleaseTrack[]>().notNull().default([]),
  videos: text("videos", { mode: "json" }).$type<ReleaseVideo[]>().notNull().default([]),
}, (table) => [index("releases_master_id_idx").on(table.masterId)]);

export type QueueJobType = "release_detail" | "fade_lookup";
export type QueueJobStatus = "pending" | "processing" | "done" | "failed";

export interface ReleaseDetailPayload {
  releaseId: number;
}

/** Resolves a fade against Discogs: a release fade finds its master, a master fade fetches its versions. */
export interface FadeLookupPayload {
  uid: string;
  kind: FadeKind;
  id: number;
}

export interface QueueJobPayloadMap {
  release_detail: ReleaseDetailPayload;
  fade_lookup: FadeLookupPayload;
}

export const discogsQueueJobs = sqliteTable("discogs_queue_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  type: text("type").$type<QueueJobType>().notNull(),
  payload: text("payload", { mode: "json" })
    .$type<ReleaseDetailPayload | FadeLookupPayload>()
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
