-- Enrichment stored the 0 Discogs sends for an unknown year; unknown is NULL.
UPDATE `releases` SET `year` = NULL WHERE `year` = 0;
