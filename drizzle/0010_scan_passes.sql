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
CREATE UNIQUE INDEX `scan_passes_run_sort_order_idx` ON `scan_passes` (`run_id`,`sort`,`order`);