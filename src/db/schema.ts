import { sqliteTable, integer, text, real, primaryKey } from "drizzle-orm/sqlite-core";

export interface ReleaseFormat {
  name: string;
  descriptions: string[];
}

export interface ReleaseArtistStub {
  id: number;
  name: string;
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
});

export type SellerIndexStatus = "never" | "running" | "success" | "error";

export const sellers = sqliteTable("sellers", {
  username: text("username").primaryKey(),
  lastIndexedAt: integer("last_indexed_at", { mode: "timestamp" }),
  lastIndexStatus: text("last_index_status").$type<SellerIndexStatus>().notNull(),
  currentRunId: text("current_run_id"),
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

export type QueueJobType = "inventory_page" | "release_detail";
export type QueueJobStatus = "pending" | "processing" | "done" | "failed";

export interface InventoryPagePayload {
  username: string;
  page: number;
  /** ISO timestamp of when this indexing run started (page 1's enqueue time), carried
   * forward unchanged through every chained page — used as the sold-diff cutoff. */
  runStartedAt: string;
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
  attempts: integer("attempts").notNull().default(0),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});
