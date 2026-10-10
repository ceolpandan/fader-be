CREATE TABLE `master_versions` (
	`master_id` integer NOT NULL,
	`release_id` integer NOT NULL,
	PRIMARY KEY(`master_id`, `release_id`)
);
--> statement-breakpoint
CREATE INDEX `master_versions_release_idx` ON `master_versions` (`release_id`);--> statement-breakpoint
ALTER TABLE `fades` ADD `lookup_status` text DEFAULT 'done' NOT NULL;