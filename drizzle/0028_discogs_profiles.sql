CREATE TABLE `discogs_profiles` (
	`uid` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`collection_count` integer NOT NULL,
	`wantlist_count` integer NOT NULL,
	`fetched_at` integer NOT NULL
);
