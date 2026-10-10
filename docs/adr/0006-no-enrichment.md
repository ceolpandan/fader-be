# Releases are no longer enriched from the Discogs API

Fader used to fetch each release the first time a collector opened it (and on Refresh), storing its cover, community rating, haves and wants. That is gone from `main` (fader-ui#100):

- **Removed:** the `release_detail` queue job and handler, `POST /releases/{id}/refresh`, the live fetch on `GET /releases/{id}` (now 404 when the release is not stored), the rating sort, and the `thumb`, `rating_average`, `rating_count`, `haves` and `wants` columns (migration `0018`, which also deletes queued `release_detail` jobs).
- **Why:** the catalogue will be filled from the monthly Discogs data dump (CC0), which has none of that data. `main` stores no Discogs API data. Personal rating enrichment lives on the `private-main` branch (fader-ui#102), which is never merged into `main`.
- **Kept:** the Discogs queue, now carrying only `fade_lookup` jobs, and the pause and backoff behaviour in `0002-discogs-outage-backoff.md`.
- **Back up first:** the migration drops columns for good. The pre-removal database was copied to `D:aderackups` as the seed for `private-main`.
