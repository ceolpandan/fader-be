CREATE TABLE `discogs_tokens` (
	`uid` text PRIMARY KEY NOT NULL,
	`token_encrypted` text NOT NULL,
	`username` text NOT NULL,
	`created_at` integer NOT NULL
);
