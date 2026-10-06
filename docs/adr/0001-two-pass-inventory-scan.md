# Scan past the 10,000 item cap with a second, descending pass

Discogs serves only the first 100 pages of 100 listings of another seller's inventory per sort order, and answers page 101 with a 403. A seller with more than 10,000 items would otherwise be indexed only up to the first 10,000 by artist.

We scan `sort=artist` ascending, then, only when `pagination.items` is above 10,000, `sort=artist` descending for `ceil((items - 10,000) / 100)` pages (at most 100). Beyond 20,000 items the middle of the sort is unreachable with one sort field; we report that honestly instead of hiding it. Further sort criteria are tracked in fader-ui#43.

- **Enrichment waits for the last pass.** Releases both passes see are linked twice (one row per seller and release) and enriched once, and the total to enrich is fixed before enrichment begins.
- **The pagination 403 is not an auth failure.** It ends the pass as `capped` with no retry. Any other 401/403 still fails the run.
- **Passes are recorded** in `scan_passes` (per run, with pages, items seen, items new to the run, status) and exposed as `scanPasses` on `GET /sellers/{username}`, so coverage can be diagnosed (fader-ui#48).
- **`coverage.reachable` counts listings seen**, capped at `total`, not distinct releases: Discogs' `pagination.items` counts listings, so a seller with several copies of a release would otherwise look under-covered. A listing that the two passes both see (ties ordered differently) is counted twice; accepted. `itemsNew` holds the distinct count.
- `artist` ties may order differently ascending and descending, so a few items near the boundary may be missed or repeated. Accepted.
