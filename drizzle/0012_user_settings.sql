CREATE TABLE `user_settings` (
	`uid` text PRIMARY KEY NOT NULL,
	`theme` text DEFAULT 'dark' NOT NULL,
	`updated_at` integer NOT NULL
);
