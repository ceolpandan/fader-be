CREATE TABLE `saved_filters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uid` text NOT NULL,
	`name` text NOT NULL,
	`query` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_filters_uid_query_idx` ON `saved_filters` (`uid`,`query`);