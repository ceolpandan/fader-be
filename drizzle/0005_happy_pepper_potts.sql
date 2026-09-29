ALTER TABLE `releases` ADD `tracklist` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `releases` ADD `videos` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
-- One-off: existing rows predate these columns. Clear them so the next seller index
-- re-fetches every release (inventory indexing enqueues release_detail for missing rows).
DELETE FROM `releases`;
