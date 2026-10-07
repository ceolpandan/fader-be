# Keep scanning further sort orders until the inventory is covered

Supersedes the "one sort field" limit and the "enrichment waits for the last pass" rule of [0001](0001-two-pass-inventory-scan.md). Tracked in fader-ui#43.

One sort order reaches at most the first and last 10,000 items of a seller's inventory. A seller over 20,000 items (SEAWOLF_RECORDS has 42,000+) needs more sort orders to bring the middle into reach. We walk these passes in order, each ascending then descending: `artist`, `listed`, `label`, `catno`, `item`, `price`, `audio`. Discogs also lists `status` and `location`, but they are owner-only; condition is not an API sort.

- **Stop when covered, not when it stops paying off.** After every pass we stop if the run has seen every inventory item (distinct `seller_inventory` rows with `lastSeenAt` since the run began, against `pagination.items`) or if one pass returned every listing. The second rule matters because `pagination.items` counts listings, so a seller with several copies of a release never shows that many distinct items. Otherwise all 14 passes run.
- **A descending pass is skipped when it has nothing to add.** It plans pages only for what the ascending pass could not reach, so an inventory of 10,000 items or fewer never gets one.
- **Enrichment starts as each pass ends.** The new releases a pass found (not stored, and not already queued in this run) are queued then, so enrichment overlaps with later passes.
- **Scan pages outrank enrichment** (`SCAN_PRIORITY` 5, above `release_detail` at 0, below inline work at 10). Without that, the first pass's enrichment, hours of work, would hold up the second pass.
- **Enrichment still gets a turn.** A scan always has its next page queued, so strict priority would starve enrichment until the whole scan ended. After `SCAN_BURST` (3) scan jobs in a row, the queue runs one lower-priority job if one is waiting. The scan is about a third slower and enrichment starts at once.
- **A failing pass costs the pass, not the run.** After the last attempt for a page, once page 1 has told us the total, the pass is recorded as `failed` and the next one starts. Auth failures, Discogs outages and a failure on the very first page still fail the run.
- **`coverage.reachable` is the distinct items seen**, so an item two passes both see counts once. This replaces the listings-seen sum from 0001.
- **Faded releases are not skipped at indexing time.** Fades are per collector and the index is shared; fading only filters what is read.
- `scanPagesTotal` is the pages of all passes planned up front, so it overstates the work when the scan stops early.
