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
A release a particular seller has on sale. It is active while the seller lists it and sold once it disappears from their listings.
_Avoid_: Listing, stock, product

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

**Refresh**:
Re-fetching one release from live Discogs and overwriting everything we store for it, regardless of when it was indexed. Not the same as a reindex, which covers a whole seller and skips releases already enriched.
_Avoid_: Reindex (for a single release), resync, update

## Discogs access

**Discogs queue**:
The single paced lane every Discogs request goes through, so we stay under Discogs' rate limit.
_Avoid_: Job runner

**Inline request**:
Work a person is actively waiting on, such as opening a release we don't have or refreshing one. It goes ahead of background indexing in the Discogs queue.
_Avoid_: Priority job, foreground job

## Hiding

**Fade**:
Hiding a release the collector isn't interested in, together with its master and every other version under that master. The extension dims faded releases on Discogs pages.
_Avoid_: Block, hide, ignore
