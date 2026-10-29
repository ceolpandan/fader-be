CREATE TABLE `release_raw` (
	`release_id` integer PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`fetched_at` integer NOT NULL
);
