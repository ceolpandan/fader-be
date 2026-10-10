CREATE TABLE `seller_listings` (
	`listing_id` integer PRIMARY KEY NOT NULL,
	`seller_username` text NOT NULL,
	`release_id` integer NOT NULL,
	`media_condition` text NOT NULL,
	`sleeve_condition` text,
	`price` real NOT NULL,
	`currency` text NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `seller_listings_seller_release_idx` ON `seller_listings` (`seller_username`,`release_id`);