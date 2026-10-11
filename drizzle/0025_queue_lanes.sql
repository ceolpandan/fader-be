ALTER TABLE `discogs_queue_jobs` ADD `uid` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Jobs queued before lanes existed belong to the collector in their payload.
UPDATE `discogs_queue_jobs` SET `uid` = COALESCE(json_extract(`payload`, '$.uid'), '');
