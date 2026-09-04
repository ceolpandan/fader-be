CREATE TABLE `releases` (
	`id` integer PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`year` integer,
	`country` text,
	`genres` text NOT NULL,
	`styles` text NOT NULL,
	`formats` text NOT NULL,
	`master_id` integer,
	`thumb` text,
	`rating_average` real,
	`rating_count` integer,
	`haves` integer,
	`wants` integer,
	`label_ids` text NOT NULL,
	`artists` text NOT NULL
);
