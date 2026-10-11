CREATE TABLE `enrichment_not_found` (
	`run_id` text NOT NULL,
	`release_id` integer NOT NULL,
	PRIMARY KEY(`run_id`, `release_id`)
);
--> statement-breakpoint
CREATE TABLE `enrichment_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`uid` text NOT NULL,
	`query` text NOT NULL,
	`fresh` integer NOT NULL,
	`status` text NOT NULL,
	`total` integer NOT NULL,
	`skipped` integer NOT NULL,
	`error_message` text,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
