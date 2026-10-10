# Fader

Fader helps a Discogs collector browse releases and hide the ones they aren't interested in. It keeps its own copy of release details so browsing doesn't depend on live Discogs. It has no sellers, inventories or listings, which the Discogs API terms of use don't allow (see `docs/adr/0005-no-seller-features.md`).

## Language

**Release**:
One specific Discogs release (a particular pressing or edition), identified by its Discogs release id.
_Avoid_: Record, album, product, item

**Master**:
The Discogs grouping of all versions of the same work. A release belongs to at most one master.
_Avoid_: Album, group

**Enriched release**:
A release whose details we have fetched from Discogs and stored. Only enriched releases appear when browsing.
_Avoid_: Synced release, cached release

**Release detail**:
What we show about one release beyond its grid row: cover, title, artists, tracklist and video links.
_Avoid_: Release info, release page

**Video link**:
A video Discogs attaches to a release, mostly YouTube.
_Avoid_: Audio link, media link

## Keeping data current

**Enrich**:
Fetch a release's details from Discogs and store them, making it an enriched release. It happens when a collector opens a release we don't have, and when a fade's lookup needs one.
_Avoid_: Sync, hydrate

**Refresh**:
Re-fetching one release from live Discogs and overwriting everything we store for it.
_Avoid_: Reindex, resync, update

## Discogs access

**Discogs queue**:
The single paced lane every Discogs request goes through, so we stay under Discogs' rate limit.
_Avoid_: Job runner

**Pause**:
When Discogs errors (429, 5xx, network failure) the whole Discogs queue stops and retries the same job after 1, 2, 4, 8, then 10 minutes, or after Discogs' `Retry-After` when longer. A pause costs the job no attempts. After about an hour of continuous failure the queue gives up and every unfinished run ends in error.
_Avoid_: Rate-limit wait, throttle

**Inline request**:
Work a person is actively waiting on, such as opening a release we don't have or refreshing one. It goes ahead of background work in the Discogs queue.
_Avoid_: Priority job, foreground job

## Hiding

**Fade**:
Hiding a release a collector isn't interested in, together with its master and every other version under that master. Fades belong to the collector who made them. The extension dims faded releases on Discogs pages.
_Avoid_: Block, hide, ignore

**Unfade**:
Remove a fade, which brings back the release, its master and every other version under that master. A fade is stored per master (or per release without one), so unfading any version unfades them all.
_Avoid_: Restore, unhide

## Who uses it

**Collector**:
A person using Fader to browse releases. Each collector has their own fades.
_Avoid_: User, customer

**Extension**:
The Chrome extension (`fader-fe`) that dims a collector's faded releases while they browse Discogs.
_Avoid_: Plugin, add-on
