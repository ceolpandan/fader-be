ALTER TABLE `releases` ADD `rating_average` real;--> statement-breakpoint
ALTER TABLE `releases` ADD `rating_count` integer;--> statement-breakpoint
ALTER TABLE `releases` ADD `enriched_at` integer;--> statement-breakpoint
ALTER TABLE `releases` ADD `missing_at` integer;--> statement-breakpoint
CREATE INDEX `releases_rating_idx` ON `releases` (("rating_average" IS NULL),"rating_average" DESC,`id`);