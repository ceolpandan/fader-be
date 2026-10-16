CREATE TABLE `scrape_releases` (
	`scrape_id` integer NOT NULL,
	`release_id` integer NOT NULL,
	PRIMARY KEY(`scrape_id`, `release_id`)
);
--> statement-breakpoint
CREATE INDEX `scrape_releases_release_idx` ON `scrape_releases` (`release_id`);--> statement-breakpoint
CREATE TABLE `scrape_unmatched` (
	`scrape_id` integer NOT NULL,
	`position` integer NOT NULL,
	`line` text NOT NULL,
	PRIMARY KEY(`scrape_id`, `position`)
);
--> statement-breakpoint
CREATE TABLE `scrapes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uid` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scrapes_uid_name_idx` ON `scrapes` (`uid`,`name`);