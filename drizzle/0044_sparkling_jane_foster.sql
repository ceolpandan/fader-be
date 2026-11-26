CREATE TABLE `scan_listings` (
	`run_id` text NOT NULL,
	`seller_username` text NOT NULL,
	`sort` text NOT NULL,
	`order` text NOT NULL,
	`listing_id` integer NOT NULL,
	PRIMARY KEY(`run_id`, `sort`, `order`, `listing_id`)
);
--> statement-breakpoint
CREATE TABLE `scan_passes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`seller_username` text NOT NULL,
	`sort` text NOT NULL,
	`order` text NOT NULL,
	`pages_planned` integer NOT NULL,
	`pages_fetched` integer DEFAULT 0 NOT NULL,
	`items_seen` integer DEFAULT 0 NOT NULL,
	`items_new` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scan_passes_run_sort_order_idx` ON `scan_passes` (`run_id`,`sort`,`order`);--> statement-breakpoint
CREATE TABLE `seller_inventory` (
	`seller_username` text NOT NULL,
	`release_id` integer NOT NULL,
	`status` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`sold_at` integer,
	PRIMARY KEY(`seller_username`, `release_id`)
);
--> statement-breakpoint
CREATE INDEX `seller_inventory_release_idx` ON `seller_inventory` (`release_id`);--> statement-breakpoint
CREATE TABLE `sellers` (
	`username` text PRIMARY KEY NOT NULL,
	`last_indexed_at` integer,
	`last_index_status` text NOT NULL,
	`current_run_id` text,
	`run_uid` text,
	`seller_rating` real,
	`seller_num_ratings` integer,
	`ships_from_country` text,
	`avatar_url` text,
	`inventory_total` integer,
	`scan_pages_total` integer,
	`scan_pages_fetched` integer DEFAULT 0 NOT NULL,
	`scan_completed_at` integer
);
