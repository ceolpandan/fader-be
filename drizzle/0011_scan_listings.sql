CREATE TABLE `scan_listings` (
	`run_id` text NOT NULL,
	`seller_username` text NOT NULL,
	`sort` text NOT NULL,
	`order` text NOT NULL,
	`listing_id` integer NOT NULL,
	PRIMARY KEY(`run_id`, `sort`, `order`, `listing_id`)
);
