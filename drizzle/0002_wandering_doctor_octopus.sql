CREATE TABLE `seller_inventory` (
	`seller_username` text NOT NULL,
	`release_id` integer NOT NULL,
	`status` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`sold_at` integer,
	PRIMARY KEY(`seller_username`, `release_id`)
);
