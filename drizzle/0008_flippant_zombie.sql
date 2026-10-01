CREATE TABLE `fades` (
	`uid` text NOT NULL,
	`kind` text NOT NULL,
	`id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`uid`, `kind`, `id`)
);
--> statement-breakpoint
CREATE INDEX `releases_master_id_idx` ON `releases` (`master_id`);