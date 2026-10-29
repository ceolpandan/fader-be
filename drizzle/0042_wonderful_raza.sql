CREATE TABLE `digital_matches` (
	`release_id` integer NOT NULL,
	`store` text NOT NULL,
	`status` text NOT NULL,
	`url` text,
	`tracks` text DEFAULT '[]' NOT NULL,
	`track_count` integer,
	`checked_at` integer NOT NULL,
	PRIMARY KEY(`release_id`, `store`)
);
