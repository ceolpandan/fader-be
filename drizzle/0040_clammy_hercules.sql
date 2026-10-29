ALTER TABLE `discogs_tokens` ADD `currency` text;--> statement-breakpoint
ALTER TABLE `releases` ADD `lowest_price_currency` text;--> statement-breakpoint
-- Prices stored so far came from the one saved account, whose marketplace currency is EUR (fader-ui#154).
UPDATE `releases` SET `lowest_price_currency` = 'EUR' WHERE `lowest_price` IS NOT NULL;
