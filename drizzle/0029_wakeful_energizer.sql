ALTER TABLE `releases` ADD `version_count` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Backfill before the index exists, so the updates don't maintain it. Same count as `refreshVersionCounts`.
WITH counts AS (SELECT `master_id`, count(*) AS n FROM `releases` WHERE `master_id` IS NOT NULL GROUP BY `master_id`)
UPDATE `releases` SET `version_count` = (SELECT n FROM counts WHERE counts.`master_id` = `releases`.`master_id`)
WHERE `master_id` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `releases_version_count_idx` ON `releases` ("version_count" DESC,`id`);
