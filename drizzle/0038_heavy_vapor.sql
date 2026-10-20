CREATE TABLE `wantlist_folder_items` (
	`uid` text NOT NULL,
	`release_id` integer NOT NULL,
	`folder_id` integer NOT NULL,
	PRIMARY KEY(`uid`, `release_id`)
);
--> statement-breakpoint
CREATE INDEX `wantlist_folder_items_folder_idx` ON `wantlist_folder_items` (`folder_id`);--> statement-breakpoint
CREATE TABLE `wantlist_folders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uid` text NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wantlist_folders_uid_name_idx` ON `wantlist_folders` (`uid`,lower("name"));