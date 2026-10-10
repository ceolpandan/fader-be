-- Videos are stored as the dump lists them: `src`, not `uri`.
UPDATE `releases` SET `videos` = (
	SELECT json_group_array(json_object('src', json_extract(value, '$.uri'), 'title', json_extract(value, '$.title'), 'duration', json_extract(value, '$.duration')))
	FROM json_each(`releases`.`videos`)
) WHERE `videos` LIKE '%"uri"%';--> statement-breakpoint
INSERT OR IGNORE INTO `release_genres` (`release_id`, `genre`) SELECT r.`id`, j.`value` FROM `releases` r, json_each(r.`genres`) j;--> statement-breakpoint
INSERT OR IGNORE INTO `release_styles` (`release_id`, `style`) SELECT r.`id`, j.`value` FROM `releases` r, json_each(r.`styles`) j;--> statement-breakpoint
INSERT OR IGNORE INTO `release_formats` (`release_id`, `format`) SELECT r.`id`, json_extract(j.`value`, '$.name') FROM `releases` r, json_each(r.`formats`) j WHERE json_extract(j.`value`, '$.name') IS NOT NULL;--> statement-breakpoint
-- The side tables follow `genres`, `styles` and `formats`, so writing a release is enough.
CREATE TRIGGER `releases_side_tables_insert` AFTER INSERT ON `releases` BEGIN
	INSERT OR IGNORE INTO `release_genres` (`release_id`, `genre`) SELECT DISTINCT NEW.`id`, j.`value` FROM json_each(NEW.`genres`) j;
	INSERT OR IGNORE INTO `release_styles` (`release_id`, `style`) SELECT DISTINCT NEW.`id`, j.`value` FROM json_each(NEW.`styles`) j;
	INSERT OR IGNORE INTO `release_formats` (`release_id`, `format`) SELECT DISTINCT NEW.`id`, json_extract(j.`value`, '$.name') FROM json_each(NEW.`formats`) j WHERE json_extract(j.`value`, '$.name') IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `releases_side_tables_delete` AFTER DELETE ON `releases` BEGIN
	DELETE FROM `release_genres` WHERE `release_id` = OLD.`id`;
	DELETE FROM `release_styles` WHERE `release_id` = OLD.`id`;
	DELETE FROM `release_formats` WHERE `release_id` = OLD.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `releases_side_tables_update` AFTER UPDATE OF `genres`, `styles`, `formats` ON `releases` BEGIN
	DELETE FROM `release_genres` WHERE `release_id` = OLD.`id`;
	DELETE FROM `release_styles` WHERE `release_id` = OLD.`id`;
	DELETE FROM `release_formats` WHERE `release_id` = OLD.`id`;
	INSERT OR IGNORE INTO `release_genres` (`release_id`, `genre`) SELECT DISTINCT NEW.`id`, j.`value` FROM json_each(NEW.`genres`) j;
	INSERT OR IGNORE INTO `release_styles` (`release_id`, `style`) SELECT DISTINCT NEW.`id`, j.`value` FROM json_each(NEW.`styles`) j;
	INSERT OR IGNORE INTO `release_formats` (`release_id`, `format`) SELECT DISTINCT NEW.`id`, json_extract(j.`value`, '$.name') FROM json_each(NEW.`formats`) j WHERE json_extract(j.`value`, '$.name') IS NOT NULL;
END;
