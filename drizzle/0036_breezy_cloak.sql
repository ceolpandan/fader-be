ALTER TABLE `releases` ADD `num_for_sale` integer;--> statement-breakpoint
ALTER TABLE `releases` ADD `num_for_sale_at` integer;--> statement-breakpoint
CREATE INDEX `releases_num_for_sale_idx` ON `releases` (("num_for_sale" IS NULL),`num_for_sale`,`id`);