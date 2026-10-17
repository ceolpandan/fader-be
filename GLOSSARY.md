# Fader

Fader helps a Discogs collector browse releases and fade the ones they aren't interested in. It keeps its own copy of release details so browsing doesn't depend on live Discogs. It has no sellers, inventories or listings.

## Language

**Release**:
One specific Discogs release (a particular pressing or edition), identified by its Discogs release id.
_Avoid_: Record, album, product, item

**Master**:
The Discogs grouping of all versions of the same work. A release belongs to at most one master.
_Avoid_: Album, group

**Version count**:
How many stored releases share a release's master (1 without a master), which is how many releases fading its master clears. Stored on the release (`version_count`) and counted by the importer, not by Discogs. Explore sorts by it with `sort=-versions`.
_Avoid_: Edition count, master size

**Release detail**:
What we show about one release beyond its grid row: title, artists, tracklist and video links.
_Avoid_: Release info, release page

**Video link**:
A video Discogs attaches to a release, mostly YouTube.
_Avoid_: Audio link, media link

## Discogs access

**Discogs queue**:
The paced lanes every Discogs request goes through, one per collector (each token has its own rate limit), so we stay under Discogs' rate limit.
_Avoid_: Job runner

**Pause**:
When Discogs errors (429 or a network failure; a 5xx too, once it keeps happening) the collector's lane stops and retries the same job after 1, 2, 4, 8, then 10 minutes, or after Discogs' `Retry-After` when longer. A pause costs the job no attempts. After about an hour of continuous failure the queue gives up and every unfinished run ends in error.
_Avoid_: Rate-limit wait, throttle

**Set aside**:
A job whose release Discogs answers with a 5xx is retried at the queue's normal pace, without a pause, up to 3 tries in all; then it is marked failed (its job row keeps the error, counted as `failed` on the run) and the lane moves on. If 5 jobs in a row are set aside with no success between, it is an outage rather than bad releases: they go back to pending and the lane pauses.
_Avoid_: Dead letter, skip

**Inline request**:
Work a person is actively waiting on, such as a fade's lookup. It goes ahead of background work in the Discogs queue.
_Avoid_: Priority job, foreground job

## Enrichment

**Enrichment run**:
A collector's fetch from the Discogs API, with their own token, of the releases a saved filter shows, to store each one's community rating and refresh its details. One active run per collector; only the latest is kept. Skips faded releases and, unless fresh, releases already enriched. See `docs/adr/0008-enrichment-runs.md`.
_Avoid_: Scan, indexing

**Fresh enrichment**:
An enrichment run that also re-fetches releases enriched before and overwrites them (and releases marked missing).
_Avoid_: Re-index, force

**Enriched release**:
A release an enrichment run has fetched from the Discogs API (it has an `enriched_at`). `enriched=only` on the release list keeps only these. The filter options are not narrowed to them: the Enriched page offers the same static list as Explore (fader-ui#112).
_Avoid_: Rated release, indexed release

**Missing release**:
A release an enrichment run found Discogs no longer has (a 404 after retries). It is marked `missing_at` and Explore hides it; a fresh enrichment clears the mark if Discogs finds it again.
_Avoid_: Deleted release, dead release

## Hiding

**Fade**:
Setting aside a release a collector isn't interested in, together with its master and every other version under that master. Fades belong to the collector who made them. The extension dims faded releases on Discogs pages.
_Avoid_: Block, ignore

**Unfade**:
Remove a fade, which brings back the release, its master and every other version under that master. A fade is stored per master (or per release without one), so unfading any version unfades them all.
_Avoid_: Restore

**Hidden**:
A release the collector already has (it is in their **Collection**) or wants (it is on their **Wantlist**), so they have no use for it in Explore. Stored per collector (`hidden_releases`), written by the **Sync**. It is never a **Fade**, and a fade is never hidden: the sync deletes the release's own fade, and the other versions are covered by the master fade it writes. Hiding is exact-release. Reading it (Explore, the "Show hidden releases" setting) is fader-ui#118.
_Avoid_: Owned, excluded, blocked

## Collection and wantlist

**Collection**:
The releases in a collector's Discogs collection, as the last **Sync** saw them: one per release, whatever the number of copies or folders. Per collector (`collection_items`); a release not in the catalogue is kept.
_Avoid_: Library, owned releases, haves

**Wantlist**:
The releases on a collector's Discogs wantlist, as the last **Sync** saw them, with when each was added. Per collector (`wantlist_items`); a release not in the catalogue is kept.
_Avoid_: Wants, wishlist

**Availability**:
How many copies of a release are for sale on Discogs (`num_for_sale`). The wantlist payload does not carry it, so it comes from a release fetch; stored on the release and shown for wantlist items (fader-ui#143, fader-ui#144). Fader has no sellers, so it is a count and nothing more.
_Avoid_: Stock, inventory, listings

**Unmatched**:
A wantlist item whose release has no row in `releases` yet (its enrichment, fader-ui#143, has not run or Discogs answered 404). It is shown on the wantlist page's Unmatched tab with the title and artists the Discogs payload gave and a source label ("Discogs wantlist"); it moves to the Wantlist tab once the release is stored. Later imports reuse the tab with their own per-collector source label, never stored on `releases`.
_Avoid_: Orphan, missing (missing is an enrichment term: Discogs no longer has the release)

**Sync**:
A collector's on-demand fetch of their **Wantlist** and then their **Collection** from Discogs, with their own token, as one job at queue priority 5. It writes nothing until every page is in, then in one transaction mirrors both lists, hides every release on either, deletes the release fade on each, and fades the master of each (unless the collector already did) so that every other version fades too. A release that leaves both lists loses its hidden row; the master fade stays. A failed sync leaves the previous data as it was. See `docs/adr/0009-collection-wantlist-sync.md`.
_Avoid_: Import, scan, refresh

## Who uses it

**Saved filter**:
A filter a collector kept on Explore: a name and the Explore URL query (without the page, sort kept). Per collector, unique on the query, no cap. Stored in `saved_filters` and carried over by the dump import, like fades.
_Avoid_: Preset, bookmark

**Scrape**:
A named list of `Artist - Title` lines a collector uploaded (a shop's stock, say), matched to releases when both the artist and the title are the same after ignoring case, accents and punctuation. A line that fits several pressings takes all of them; a line that matches nothing is kept as unmatched. Per collector, unique on the name; Explore filters by it and shows the unmatched lines. The matched releases are shared catalogue rows, so enriching them benefits every collector. Stored in `scrapes`, `scrape_releases` and `scrape_unmatched`, and carried over by the dump import.

A collector with a Discogs token also has each unmatched line searched on Discogs after the upload (a `scrape_search` job, ahead of enrichment): the line as written, minus special characters, and the first release Discogs returns links to it. Such a match carries a marker until the collector commits it, and can be unlinked, which returns the line to unmatched as rejected. A hit the catalogue lacks is fetched first, so it counts as enriched. Stored in `scrape_search_matches`.
_Avoid_: Import, upload (for the list itself), wishlist

**Collector**:
A person using Fader to browse releases. Each collector has their own fades.
_Avoid_: User, customer

**Extension**:
The Chrome extension (`fader-fe`) that dims a collector's faded releases while they browse Discogs.
_Avoid_: Plugin, add-on
