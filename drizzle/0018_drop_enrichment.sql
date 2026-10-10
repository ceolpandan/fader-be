ALTER TABLE `releases` DROP COLUMN `thumb`;--> statement-breakpoint
ALTER TABLE `releases` DROP COLUMN `rating_average`;--> statement-breakpoint
ALTER TABLE `releases` DROP COLUMN `rating_count`;--> statement-breakpoint
ALTER TABLE `releases` DROP COLUMN `haves`;--> statement-breakpoint
ALTER TABLE `releases` DROP COLUMN `wants`;--> statement-breakpoint
DELETE FROM `discogs_queue_jobs` WHERE `type` = 'release_detail';
