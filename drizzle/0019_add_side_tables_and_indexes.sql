CREATE TABLE `release_formats` (
	`release_id` integer NOT NULL,
	`format` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_formats_format_idx` ON `release_formats` (`format`,`release_id`);--> statement-breakpoint
CREATE INDEX `release_formats_release_idx` ON `release_formats` (`release_id`,`format`);--> statement-breakpoint
CREATE TABLE `release_genres` (
	`release_id` integer NOT NULL,
	`genre` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_genres_genre_idx` ON `release_genres` (`genre`,`release_id`);--> statement-breakpoint
CREATE INDEX `release_genres_release_idx` ON `release_genres` (`release_id`,`genre`);--> statement-breakpoint
CREATE TABLE `release_styles` (
	`release_id` integer NOT NULL,
	`style` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_styles_style_idx` ON `release_styles` (`style`,`release_id`);--> statement-breakpoint
CREATE INDEX `release_styles_release_idx` ON `release_styles` (`release_id`,`style`);--> statement-breakpoint
ALTER TABLE `releases` ADD `labels` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `releases` ADD `track_count` integer GENERATED ALWAYS AS (json_array_length(tracklist)) VIRTUAL;--> statement-breakpoint
ALTER TABLE `releases` ADD `artist_sort` text GENERATED ALWAYS AS (json_extract(artists, '$[0].name')) VIRTUAL;--> statement-breakpoint
ALTER TABLE `releases` ADD `format_sort` text GENERATED ALWAYS AS (json_extract(formats, '$[0].name')) VIRTUAL;--> statement-breakpoint
CREATE INDEX `releases_title_idx` ON `releases` (`title`,`id`);--> statement-breakpoint
CREATE INDEX `releases_year_idx` ON `releases` (`year`,`id`);--> statement-breakpoint
CREATE INDEX `releases_artist_sort_idx` ON `releases` (`artist_sort`,`id`);--> statement-breakpoint
CREATE INDEX `releases_format_sort_idx` ON `releases` (`format_sort`,`id`);--> statement-breakpoint
CREATE INDEX `releases_track_count_idx` ON `releases` (("track_count" = 0),"track_count" DESC,`id`);--> statement-breakpoint
CREATE INDEX `releases_country_idx` ON `releases` (`country`,`id`);