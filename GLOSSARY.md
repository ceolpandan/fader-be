# Fader

Fader helps a Discogs collector browse releases and hide the ones they aren't interested in. It keeps its own copy of release details so browsing doesn't depend on live Discogs. It has no sellers, inventories or listings, which the Discogs API terms of use don't allow (see `docs/adr/0005-no-seller-features.md`).

## Language

**Release**:
One specific Discogs release (a particular pressing or edition), identified by its Discogs release id.
_Avoid_: Record, album, product, item

**Master**:
The Discogs grouping of all versions of the same work. A release belongs to at most one master.
_Avoid_: Album, group

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
When Discogs errors (429, 5xx, network failure) the collector's lane stops and retries the same job after 1, 2, 4, 8, then 10 minutes, or after Discogs' `Retry-After` when longer. A pause costs the job no attempts. After about an hour of continuous failure the queue gives up and every unfinished run ends in error.
_Avoid_: Rate-limit wait, throttle

**Inline request**:
Work a person is actively waiting on, such as a fade's lookup. It goes ahead of background work in the Discogs queue.
_Avoid_: Priority job, foreground job

## Enrichment

**Enrichment run**:
A collector's fetch from the Discogs API, with their own token, of the releases a saved filter shows, to store each one's community rating and refresh its details. One active run per collector; only the latest is kept. Skips faded releases and, unless fresh, releases already enriched. See `docs/adr/0008-enrichment-runs.md`.
_Avoid_: Scan, indexing, sync

**Fresh enrichment**:
An enrichment run that also re-fetches releases enriched before and overwrites them (and releases marked missing).
_Avoid_: Re-index, force

**Enriched release**:
A release an enrichment run has fetched from the Discogs API (it has an `enriched_at`). `enriched=only` on the release list and filter-options endpoints keeps only these.
_Avoid_: Rated release, indexed release

**Missing release**:
A release an enrichment run found Discogs no longer has (a 404 after retries). It is marked `missing_at` and Explore hides it; a fresh enrichment clears the mark if Discogs finds it again.
_Avoid_: Deleted release, dead release

## Hiding

**Fade**:
Hiding a release a collector isn't interested in, together with its master and every other version under that master. Fades belong to the collector who made them. The extension dims faded releases on Discogs pages.
_Avoid_: Block, hide, ignore

**Unfade**:
Remove a fade, which brings back the release, its master and every other version under that master. A fade is stored per master (or per release without one), so unfading any version unfades them all.
_Avoid_: Restore, unhide

## Who uses it

**Saved filter**:
A filter a collector kept on Explore: a name and the Explore URL query (without the page, sort kept). Per collector, unique on the query, no cap. Stored in `saved_filters` and carried over by the dump import, like fades.
_Avoid_: Preset, bookmark

**Collector**:
A person using Fader to browse releases. Each collector has their own fades.
_Avoid_: User, customer

**Extension**:
The Chrome extension (`fader-fe`) that dims a collector's faded releases while they browse Discogs.
_Avoid_: Plugin, add-on
