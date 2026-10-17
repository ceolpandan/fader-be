CREATE TABLE `scrape_search_matches` (
	`scrape_id` integer NOT NULL,
	`position` integer NOT NULL,
	`line` text NOT NULL,
	`query` text NOT NULL,
	`status` text NOT NULL,
	`release_id` integer,
	`committed` integer DEFAULT false NOT NULL,
	`added_release` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`scrape_id`, `position`)
);
--> statement-breakpoint
CREATE INDEX `scrape_search_matches_query_idx` ON `scrape_search_matches` (`query`);