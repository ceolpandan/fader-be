# Fader

Fader helps a Discogs collector browse what sellers have on sale and hide what they aren't interested in. It keeps its own copy of sellers' inventories and release details so browsing doesn't depend on live Discogs.

## Language

**Seller**:
A Discogs user whose marketplace inventory we index and let the collector browse.
_Avoid_: Shop, store, vendor

**Release**:
One specific Discogs release (a particular pressing or edition), identified by its Discogs release id and shared by every seller who has it.
_Avoid_: Record, album, product, item

**Master**:
The Discogs grouping of all versions of the same work. A release belongs to at most one master.
_Avoid_: Album, group

**Inventory item**:
A release a particular seller had on sale when we last scanned them, backed by one or more listings.
_Avoid_: Stock, product

**Listing**:
One copy of a release that a seller has for sale, with its own media condition and price. A seller can have several listings of the same release.
_Avoid_: Copy, offer

**Enriched release**:
A release whose details we have fetched from Discogs and stored. Only enriched releases appear when browsing a seller's inventory.
_Avoid_: Synced release, cached release

**Release detail**:
What we show about one release beyond its grid row: cover, title, artists, tracklist and video links.
_Avoid_: Release info, release page

**Video link**:
A video Discogs attaches to a release, mostly YouTube.
_Avoid_: Audio link, media link

## Keeping data current

**Indexing**:
Fetching a seller's whole inventory and enriching each release we don't have yet. Running it again for the same seller is a reindex.
_Avoid_: Crawl, scrape, sync

**Remove** (a seller):
Delete a seller and what hangs off it (inventory links, scan passes, queued jobs), stopping any run in progress. Releases stay, because other sellers share them, and so do fades. It is also how a collector cancels indexing. A remove is never a fade.
_Avoid_: Delete, forget, cancel, stop

**Run**:
One execution of indexing for one seller, from start to finish. A reindex is a new run for a seller we have indexed before. A run can end successfully even when some releases failed to enrich.
_Avoid_: Job, task

**Enrich**:
Fetch a release's details from Discogs and store them, making it an enriched release. A run scans first, then enriches.
_Avoid_: Sync, hydrate

**Refresh**:
Re-fetching one release from live Discogs and overwriting everything we store for it, regardless of when it was indexed. Not the same as a reindex, which covers a whole seller and skips releases already enriched.
_Avoid_: Reindex (for a single release), resync, update

**Scan**:
The first phase of indexing: walking a seller's inventory pages to record which releases they have. Enriching the releases we don't have yet starts as each scan pass ends.
_Avoid_: Crawl

**Scan pass**:
One sorted walk over a seller's inventory within a scan. Discogs serves only the first 100 pages (10,000 items) per sort order, so a scan keeps walking further sorts (artist, listed, label, catno, item, price, audio), each ascending then descending, until it has seen every item or run out of passes. A pass ends **capped** when Discogs refuses to paginate any further, and **failed** when a page kept failing.
_Avoid_: Round, sweep

**Coverage**:
How many of a seller's inventory items a scan reached: distinct items seen in the run, out of Discogs' listing total. A pass that returned every listing counts as full coverage, since several copies of a release would otherwise never add up to the total.
_Avoid_: Completeness, progress

## Discogs access

**Discogs queue**:
The single paced lane every Discogs request goes through, so we stay under Discogs' rate limit.
_Avoid_: Job runner

**Pause**:
When Discogs errors (429, 5xx, network failure) the whole Discogs queue stops and retries the same job after 1, 2, 4, 8, then 10 minutes, or after Discogs' `Retry-After` when longer. A pause costs the job no attempts. After about an hour of continuous failure the queue gives up and every unfinished run ends in error.
_Avoid_: Rate-limit wait, throttle

**Inline request**:
Work a person is actively waiting on, such as opening a release we don't have or refreshing one. It goes ahead of background indexing in the Discogs queue.
_Avoid_: Priority job, foreground job

## Hiding

**Fade**:
Hiding a release a collector isn't interested in, together with its master and every other version under that master. Fades belong to the collector who made them. The extension dims faded releases on Discogs pages.
_Avoid_: Block, hide, ignore

## Who uses it

**Collector**:
A person using Fader to browse sellers' inventories. Each collector has their own fades.
_Avoid_: User, customer

**Extension**:
The Chrome extension (`fader-fe`) that dims a collector's faded releases while they browse Discogs.
_Avoid_: Plugin, add-on
