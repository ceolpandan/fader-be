ALTER TABLE `sellers` ADD `inventory_total` integer;--> statement-breakpoint
ALTER TABLE `sellers` ADD `scan_pages_total` integer;--> statement-breakpoint
ALTER TABLE `sellers` ADD `scan_pages_fetched` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sellers` ADD `scan_completed_at` integer;