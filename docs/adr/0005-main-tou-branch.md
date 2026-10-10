# `main-tou` drops sellers, inventories and listings to comply with the Discogs terms of use

`main` indexes sellers' marketplace inventories (inventory pages, listings with condition and price, seller profiles) into the database. The Discogs API terms of use don't allow that, so `main-tou` (here and in `fader-ui`) is the compliant version of Fader.

- **Kept:** `GET /releases` (list, facets, detail, refresh), `/masters/{id}`, `/fade`, `/settings`, and the Discogs queue with its release-detail and fade-lookup jobs.
- **Removed:** every `/sellers` endpoint, the inventory, seller-profile and run-completion code, the sold-inventory purge, the price filter and price facets, and the `sellers`, `seller_inventory`, `seller_listings`, `scan_passes` and `scan_listings` tables. The inventory-scan and sort-order ADRs went with them.
- **Stored data:** migration `0017` drops those tables and deletes the queued indexing jobs and the enrichment jobs seller runs left behind. `npm run db:migrate` then runs `VACUUM`, since SQLite keeps dropped rows in the file's free pages until it is rebuilt. Releases already enriched stay: they are Discogs release data, not seller data.
- **`main` is untouched**, and so is the database it runs on: run `main-tou` against its own `DB_PATH`, or against a copy of the file. Do not merge `main-tou` into `main`, and do not port seller, inventory, listing or price features onto `main-tou`.
- The `changelog/` phase notes are history from before this branch and still describe the seller work.
