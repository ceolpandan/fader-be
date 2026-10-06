import { sqliteTable, integer, text, real, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";

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

export type SellerIndexStatus = "never" | "running" | "success" | "error";

export const sellers = sqliteTable("sellers", {
  username: text("username").primaryKey(),
  lastIndexedAt: integer("last_indexed_at", { mode: "timestamp" }),
  lastIndexStatus: text("last_index_status").$type<SellerIndexStatus>().notNull(),
  currentRunId: text("current_run_id"),
  sellerRating: real("seller_rating"),
  sellerNumRatings: integer("seller_num_ratings"),
  shipsFromCountry: text("ships_from_country"),
  /** Discogs' `pagination.items` for the seller's inventory, known once page 1 is fetched. */
  inventoryTotal: integer("inventory_total"),
  /** Inventory pages the current run will scan (capped at the Discogs 100-page limit). */
  scanPagesTotal: integer("scan_pages_total"),
  scanPagesFetched: integer("scan_pages_fetched").notNull().default(0),
  /** Set when the scan phase ends and the release_detail jobs are queued. */
  scanCompletedAt: integer("scan_completed_at", { mode: "timestamp" }),
});

export type SellerInventoryStatus = "active" | "sold";

export const sellerInventory = sqliteTable(
  "seller_inventory",
  {
    sellerUsername: text("seller_username").notNull(),
    releaseId: integer("release_id").notNull(),
    status: text("status").$type<SellerInventoryStatus>().notNull(),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }).notNull(),
    soldAt: integer("sold_at", { mode: "timestamp" }),
  },
  (table) => [primaryKey({ columns: [table.sellerUsername, table.releaseId] })],
);

export type ScanSort = "artist";
export type ScanOrder = "asc" | "desc";
/** `capped`: Discogs refused to paginate any further, so the pass ended cleanly. */
export type ScanPassStatus = "running" | "done" | "capped";

/** One sorted walk over a seller's inventory within an indexing run, kept for diagnosing coverage. */
export const scanPasses = sqliteTable(
  "scan_passes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    sellerUsername: text("seller_username").notNull(),
    sort: text("sort").$type<ScanSort>().notNull(),
    order: text("order").$type<ScanOrder>().notNull(),
    pagesPlanned: integer("pages_planned").notNull(),
    pagesFetched: integer("pages_fetched").notNull().default(0),
    /** Listings Discogs returned in this pass. */
    itemsSeen: integer("items_seen").notNull().default(0),
    /** Inventory links this pass was the first of the run to see. */
    itemsNew: integer("items_new").notNull().default(0),
    status: text("status").$type<ScanPassStatus>().notNull(),
    startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp" }),
  },
  (table) => [uniqueIndex("scan_passes_run_sort_order_idx").on(table.runId, table.sort, table.order)],
);

export type QueueJobType = "inventory_page" | "release_detail";
export type QueueJobStatus = "pending" | "processing" | "done" | "failed";

export interface InventoryPagePayload {
  username: string;
  page: number;
  /** ISO timestamp of when this indexing run started (page 1's enqueue time), carried
   * forward unchanged through every chained page — used as the sold-diff cutoff. */
  runStartedAt: string;
  /** Sort of the pass this page belongs to; jobs queued before two-pass scanning omit it. */
  sort?: ScanSort;
  order?: ScanOrder;
}

export interface ReleaseDetailPayload {
  releaseId: number;
}

export interface QueueJobPayloadMap {
  inventory_page: InventoryPagePayload;
  release_detail: ReleaseDetailPayload;
}

export const discogsQueueJobs = sqliteTable("discogs_queue_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  type: text("type").$type<QueueJobType>().notNull(),
  payload: text("payload", { mode: "json" })
    .$type<InventoryPagePayload | ReleaseDetailPayload>()
    .notNull(),
  status: text("status").$type<QueueJobStatus>().notNull().default("pending"),
  priority: integer("priority").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export type FadeKind = "master" | "release";

/** What a user faded: a master (hides every version under it) or a release without a master. */
export const fades = sqliteTable(
  "fades",
  {
    uid: text("uid").notNull(),
    kind: text("kind").$type<FadeKind>().notNull(),
    id: integer("id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.uid, table.kind, table.id] })],
);
