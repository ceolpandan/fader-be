# A seller's inventory is scanned in as many sort orders as it takes

Brings back the seller indexing that `fc56211`/`842795e` removed, adapted to per-collector tokens and lanes (`0002-discogs-outage-backoff.md`) and to the data-dump catalogue (`0007-catalogue-from-data-dump.md`). The earlier design is in the history of `0001-two-pass-inventory-scan.md` and `0004-more-sort-orders-until-covered.md`; this record replaces both.

## Why several sort orders

Discogs serves only the first 100 pages of 100 listings of another seller's inventory per sort order, and answers page 101 with a 403 ("Pagination above..."). One order therefore reaches at most the first 10,000 items, or with a descending pass as well, the first and last 10,000. A seller over 20,000 items needs more sort fields to bring the middle into reach.

## The scan

- **Passes, in order:** `artist`, `listed`, `label`, `catno`, `item`, `price`, `audio`, each ascending then descending. (`status` and `location` are owner-only; condition is not an API sort.)
- **Stop when covered, not when it stops paying off.** After every pass the scan stops if the run has read every listing Discogs reports (distinct `scan_listings` against `pagination.items`). Listings, not releases: a seller with several copies of a release never shows that many distinct releases. Otherwise all 14 passes run.
- **A descending pass plans only what the ascending pass could not reach**, so an inventory of 10,000 items or fewer never gets one. It keeps going past its plan until it meets a listing the ascending pass of the same sort read, because the inventory shifts while it is scanned.
- **The pagination 403 is not an auth failure.** It ends the pass as `capped` with no retry. Any other 401/403 still fails the run.
- **A failing pass costs the pass, not the run.** After the last attempt for a page, once page 1 has told us the total, the pass is recorded as `failed` and the next one starts. Auth failures, Discogs outages and a failure on the very first page still fail the run.
- **Passes are recorded** in `scan_passes` and exposed as `scanPasses` on `GET /sellers/{username}`, so coverage can be diagnosed.
- **`coverage.reachable` is the distinct items seen** in the run, so an item two passes see counts once. `artist` ties may order differently ascending and descending, so a few items near a boundary may be missed or repeated; accepted.

## Whose token, which lane

The collector who starts a run lends their own token: the scan pages, the profile check and the release fetches are all queued with their `uid`, on their lane, paced and paused like any other work of theirs. `sellers.run_uid` remembers who, so the status can show that lane's pause. Starting a run without a saved token answers 409 `token_required`, and a page that finds the token gone fails the scan (the seller ends in `error`).

Scan jobs run at `SCAN_PRIORITY` (4): ahead of background enrichment (0) and availability fetches (1), behind searches and syncs (5). A scan always has its next page queued, so after `SCAN_BURST` (3) scan jobs in a row a lane runs one lower-priority job if one waits. The scan is about a third slower and enrichment starts at once.

## What a scan stores

- `sellers`: one row per Discogs username, under the casing Discogs reports, with rating, avatar, ships-from, the total, scan progress and the current run. Shared by every collector.
- `seller_inventory`: one row per seller and release (`active` or `sold`). Several copies are one row.
- `scan_passes`, `scan_listings`: the diagnostics and the coverage proof of the current run; `scan_listings` is cleared when the seller is indexed again.
- Prices, conditions and individual listings are **not** stored.

## Releases that need their details

The catalogue holds only the Electronic releases of the data dump, so a seller can list releases with no `releases` row, and the rows the dump made carry no Discogs details (rating, haves, price) until an enrichment run fetches them. As each pass ends, every release the run has seen that is in either state, and not yet queued, gets a `release_detail` job (enrichment, `0008-enrichment-runs.md`), which inserts or fills the row. Releases Discogs reported gone (`missing_at`) and releases another run already has waiting are left alone. A big seller therefore queues thousands of fetches (about 1.1 s each on the collector's lane, behind the scan) and stays `running` until they are done; it is then `success`. Removing the seller drops the queued jobs, which is how to stop it. Starting another run waits until this one ends (409 `run_active`).

- **Faded releases are skipped** for the collector who started the run: they would not see them, and each fetch costs a request. They are queued again when the collector unfades a release or master that covered them (`DELETE /fade`, with a saved token). A skipped release is still unenriched, so another collector's run still fetches it.
- Explore hides releases marked missing, so a seller's release that Discogs no longer has drops out of the filter.

## Sold items

A run that read every listing marks the seller's `active` items it did not see as `sold`. After a partial scan an unseen item may just be out of reach, so nothing is marked. Sold rows are purged after 30 days (`startSoldInventoryPurgeLoop`). A seller seen again becomes `active`.

## A run's end

`success` once the scan has finished and no job of the run is left, even if some releases failed to fetch. `error` when the scan never finished (a page failed for good, no token) or the run was aborted (Discogs gave up or rejected the token). On start-up a `running` seller with no job left is set to `error`, so it can be indexed again.
