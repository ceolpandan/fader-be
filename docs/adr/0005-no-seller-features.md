# Sellers, inventories and listings were removed to comply with the Discogs terms of use

Fader used to index sellers' marketplace inventories (inventory pages, listings with condition and price, seller profiles) into the database. The Discogs API terms of use don't allow that, so it was removed (here and in `fader-ui`, on the former `main-tou` branch, now merged into `main`).

- **Kept:** `GET /releases` (list, facets, detail), `/masters/{id}`, `/fade`, `/settings`, and the Discogs queue with its fade-lookup job.
- **Removed:** every `/sellers` endpoint, the inventory, seller-profile and run-completion code, the sold-inventory purge, the price filter and price facets, and the `sellers`, `seller_inventory`, `seller_listings`, `scan_passes` and `scan_listings` tables. The inventory-scan and sort-order ADRs went with them.
- **Stored data:** migration `0017` drops those tables and deletes the queued indexing jobs and the enrichment jobs seller runs left behind. `npm run db:migrate` then runs `VACUUM`, since SQLite keeps dropped rows in the file's free pages until it is rebuilt. Releases already enriched stay: they are Discogs release data, not seller data. The migration is irreversible: back up the database file before running it.
- **Do not bring them back:** don't add seller, inventory, listing or price features, or port them from the git history before the merge.
- The `changelog/` phase notes are history from before the removal and still describe the seller work.
