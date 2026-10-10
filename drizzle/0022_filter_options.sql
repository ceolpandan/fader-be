CREATE TABLE `filter_options` (
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`kind`, `value`)
);--> statement-breakpoint
-- Fill it from the releases already stored; the importer refills it after each load.
INSERT INTO `filter_options` (`kind`, `value`, `position`) SELECT 'genre', `genre`, ROW_NUMBER() OVER (ORDER BY count(*) DESC, `genre`) FROM `release_genres` GROUP BY `genre`;--> statement-breakpoint
INSERT INTO `filter_options` (`kind`, `value`, `position`) SELECT 'style', `style`, ROW_NUMBER() OVER (ORDER BY count(*) DESC, `style`) FROM `release_styles` GROUP BY `style`;--> statement-breakpoint
INSERT INTO `filter_options` (`kind`, `value`, `position`) SELECT 'format', `format`, ROW_NUMBER() OVER (ORDER BY count(*) DESC, `format`) FROM `release_formats` GROUP BY `format`;--> statement-breakpoint
INSERT INTO `filter_options` (`kind`, `value`, `position`) SELECT 'country', `country`, ROW_NUMBER() OVER (ORDER BY count(*) DESC, `country`) FROM `releases` WHERE `country` IS NOT NULL GROUP BY `country`;
