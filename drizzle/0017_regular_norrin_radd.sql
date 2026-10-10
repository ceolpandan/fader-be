DROP TABLE `scan_listings`;--> statement-breakpoint
DROP TABLE `scan_passes`;--> statement-breakpoint
DROP TABLE `seller_inventory`;--> statement-breakpoint
DROP TABLE `seller_listings`;--> statement-breakpoint
DROP TABLE `sellers`;--> statement-breakpoint
-- Queue jobs left over from indexing sellers: the scan jobs, and the enrichment of releases only a seller listed.
DELETE FROM `discogs_queue_jobs` WHERE `type` IN ('inventory_page', 'seller_profile')
  OR (`type` = 'release_detail' AND `run_id` NOT LIKE 'inline-%' AND `run_id` NOT LIKE 'unfade:%');
