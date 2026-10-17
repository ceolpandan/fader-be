CREATE TABLE `collection_items` (
	`uid` text NOT NULL,
	`release_id` integer NOT NULL,
	`master_id` integer,
	`title` text NOT NULL,
	`artists` text NOT NULL,
	PRIMARY KEY(`uid`, `release_id`)
);
--> statement-breakpoint
CREATE TABLE `hidden_releases` (
	`uid` text NOT NULL,
	`release_id` integer NOT NULL,
	PRIMARY KEY(`uid`, `release_id`)
);
--> statement-breakpoint
CREATE TABLE `wantlist_items` (
	`uid` text NOT NULL,
	`release_id` integer NOT NULL,
	`master_id` integer,
	`title` text NOT NULL,
	`artists` text NOT NULL,
	`added_at` integer,
	PRIMARY KEY(`uid`, `release_id`)
);
--> statement-breakpoint
ALTER TABLE `discogs_profiles` ADD `last_synced_at` integer;