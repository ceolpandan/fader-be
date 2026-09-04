# Discogs seller inventory indexing

Status: agreed

## Goal

Given a Discogs seller's username, fetch their full marketplace inventory, persist the set of
release ids they sell, and enrich each release with detail data from Discogs — all through a
single rate-limited request queue shared by every Discogs API call this backend makes (59
req/min, just under Discogs' documented 60/min authenticated limit).

Frontend consumption (fader-fe for now, later a dedicated Angular dashboard) is out of scope for
this spec beyond the API surface below: enter a username, land on a status page while indexing
runs, then browse the seller's active/sold inventory once ready.

## Discogs wrapper layer (internal only — not exposed via our HTTP API / Swagger)

Extends the existing `src/discogs-client.ts` pattern (personal access token auth,
`DISCOGS_TOKEN` env var, already in place):

- `getRelease(id)` — already exists, reused here for per-release enrichment.
- `getInventory(username, page)` — new. One page at a time, `per_page=100` (Discogs' max).
  Each listing embeds `release: {id, resource_url, catalog_number, year, description}` — a
  stub, not full release detail.

No artist-detail wrapper. Artist enrichment (a separate `artists` table, full profile fetched via
`/artists/{id}`) is explicitly out of scope for this phase — see "Deferred" below.

## Database

SQLite via Drizzle ORM to start (no infra to stand up, trivial local reset). Schema is written to
be portable to Postgres via Drizzle once this needs to run on more than one process / stabilizes
toward production.

### `releases`

Shared/global table — one row per Discogs release id, regardless of which seller(s) sell it.

| column          | type          | notes                                              |
|-----------------|---------------|-----------------------------------------------------|
| id              | integer PK    | Discogs release id                                 |
| title           | text          |                                                     |
| year            | integer       |                                                     |
| country         | text          |                                                     |
| genres          | json (text[]) |                                                     |
| styles          | json (text[]) |                                                     |
| formats         | json          | `{name, descriptions}[]` (qty dropped)              |
| master_id       | integer       | nullable                                           |
| thumb           | text          | thumbnail image URL                                |
| rating_average  | real          | from Discogs `community.rating.average`             |
| rating_count    | integer       | from Discogs `community.rating.count`               |
| haves           | integer       | from Discogs `community.have`                       |
| wants           | integer       | from Discogs `community.want`                       |
| label_ids       | json (int[])  | ids only, not full label objects                   |
| artists         | json          | `{id, name}[]` — stub only, no `anv`                |

Explicitly **not** persisted: `resource_url` (constructible from `id`), `tracklist`, `community`
(raw blob — only rating/haves/wants extracted), `estimated_weight`, `identifiers`, `companies`,
`notes`, `videos`, `data_quality`, `released_formatted`, `extraartists`, `lowest_price`,
`num_for_sale`.

Dedup rule: a release id already present in this table is treated as complete forever — no
enrichment job is enqueued for it again, and there is no age-based refresh. Release master data
rarely changes; re-fetching a known release only burns rate-limit budget.

### `seller_inventory`

| column          | type      | notes                                                        |
|-----------------|-----------|---------------------------------------------------------------|
| seller_username | text      | part of composite unique key with `release_id`                |
| release_id      | integer   | references `releases.id` (may not exist yet — see below)      |
| status          | text      | `active` \| `sold`                                            |
| first_seen_at   | timestamp | set once, on first discovery                                   |
| last_seen_at    | timestamp | bumped every time a refresh confirms the listing is still up  |
| sold_at         | timestamp | nullable; cleared if relisted                                  |

A row can exist before its corresponding `releases` row does — the inventory scan discovers ids
independently of enrichment, which happens later via the queue.

Refresh semantics (re-running indexing for an already-indexed seller):
- Every release id seen in this run: upsert row, `status = active`, bump `last_seen_at`, clear
  `sold_at` if it was previously `sold` (relisting).
- Any row not touched by this run (i.e. `last_seen_at` older than this run's start): mark
  `status = sold`, set `sold_at = now` (only if not already sold).
- Rows with `status = sold` are purged automatically at most 30 days after `sold_at`. The user can
  also delete sold rows earlier on demand (mechanism TBD at implementation time — not spec'd
  further here since it's a simple delete, no open design question).

This diff is what lets a re-index show "what's new since last time" and "what sold since last
time."

### `sellers`

| column             | type      | notes                                                  |
|--------------------|-----------|----------------------------------------------------------|
| username           | text PK   |                                                          |
| last_indexed_at    | timestamp | nullable (never indexed yet)                             |
| last_index_status  | text      | `never` \| `running` \| `success` \| `error`             |

### `discogs_queue_jobs`

Durable job table — the rate-limited queue's storage. Survives a server restart; for now this
worker runs in the same process as the API, but the design doesn't preclude moving it to a
separate process/server later.

| column         | type      | notes                                                          |
|----------------|-----------|------------------------------------------------------------------|
| id             | integer PK, autoincrement |                                                   |
| run_id         | text      | generated fresh per `POST /sellers/:username/index` call        |
| type           | text      | `inventory_page` \| `release_detail`                            |
| payload        | json      | `{username, page}` or `{releaseId}`                              |
| status         | text      | `pending` \| `processing` \| `done` \| `failed`                  |
| attempts       | integer   | default 0                                                         |
| error_message  | text      | nullable                                                          |
| created_at     | timestamp |                                                                    |
| updated_at     | timestamp |                                                                    |

## Own API (Swagger-documented — this is the surface our frontend/dashboard actually calls)

- `POST /sellers/:username/index`
  - Starts (or re-triggers) indexing for a seller. Generates a fresh `run_id`.
  - `202 Accepted` on start.
  - `409 Conflict` if `sellers.last_index_status = running` for this username already — same
    endpoint serves both first-index and refresh; never double-queues a seller.

- `GET /sellers/:username`
  - Status resource for the landing page shown while indexing runs.
  - Returns `{ username, lastIndexedAt, lastIndexStatus, currentlyRunning, totalReleasesFound,
    releasesEnriched, releasesFailed }`. The three counts are derived live from
    `discogs_queue_jobs` (`COUNT ... GROUP BY status` for `type = release_detail` and the current
    `run_id`) — turns the landing page into an actual progress bar, not just a spinner.

- `GET /sellers/:username/inventory?status=active|sold|all&page=&pageSize=`
  - Paginated, lightweight rows joined `seller_inventory` → `releases`:
    `{ releaseId, title, thumb, year, status, firstSeenAt, soldAt }`.
  - Only returns rows whose release is already enriched (i.e. has a `releases` row) — no
    placeholder/pending rows. This is intentional: the frontend gates access to this endpoint
    behind the status landing page while `currentlyRunning = true`, so a caller only hits this
    once indexing has finished (or far enough along that most releases are enriched).
  - Full release detail for a single id stays on the existing `GET /releases/:id`.

## Queue / worker design

**Pacing**: strictly serial, one Discogs HTTP call at a time, fixed ~1017ms delay between calls
(60000ms / 59). No rolling-window bookkeeping — Discogs' own `X-Discogs-Ratelimit*` response
headers are logged for sanity-checking only, not actively reacted to.

**Concurrency model**: a single worker loop drains `discogs_queue_jobs` globally — one FIFO queue
(ordered by `id`/`created_at`) shared across every seller being indexed and every job type. No
per-seller sub-limits, no priority jumping.

**Inventory pagination — chained, not pre-enqueued**: `POST /sellers/:username/index` enqueues
exactly one `inventory_page` job for page 1. When a page job runs:
1. Fetch that page.
2. For every release id on the page not already present in `releases`, enqueue a
   `release_detail` job (same `run_id`).
3. Upsert the corresponding `seller_inventory` rows (`active`, bump `last_seen_at`, clear
   `sold_at` if relisted).
4. If the response has a `next` page link, enqueue the next `inventory_page` job (`page + 1`,
   same `run_id`).
5. If there is no `next` link, this page job is the last one for the run: run the sold-diff pass
   (any `seller_inventory` row for this username with `last_seen_at` older than this run's start
   → `status = sold`, `sold_at = now`).

This keeps pagination resumable (a crash mid-run only loses at most the in-flight page, not the
whole scan) and avoids guessing total page count upfront.

**Retries**: up to 3 attempts per job, exponential backoff starting ~2s, then `status = failed`
with `error_message` set. A failed job never blocks other jobs or the run as a whole.

**Crash recovery**: on server boot, any job left in `status = processing` is reset to `pending`.
Safe because every job is an idempotent read (re-fetching a page or a release just re-upserts).

**Run completion**: a run is `success` once its inventory pagination is fully done (no more
chained `inventory_page` jobs pending) **and** no `release_detail` job for that `run_id` is left
`pending`/`processing`. Individual `release_detail` failures (after exhausting retries) do **not**
flip the whole run to `error` — a handful of bad release ids shouldn't block the rest from being
considered indexed. The failed count remains visible via `GET /sellers/:username`.

## Deferred (explicitly out of scope for this phase)

- **Artist table / enrichment**: release rows keep artist data as a raw `{id, name}` stub only
  (see `releases.artists` above). No `/artists/{id}` calls, no separate `artists` table. Revisit
  later if needed — the release row already carries enough to backfill this without re-fetching
  inventories.
- **Postgres migration**: schema is Drizzle-portable; actual cutover happens when this stabilizes
  toward production, not now.
- **Separate worker process**: the queue worker runs in-process with the API for now. The job
  table design doesn't preclude splitting it out later.
- **Manual early-delete of sold rows**: mentioned as wanted ("at most 30 days... when I want"),
  but the deletion mechanism itself isn't spec'd here — plain delete, no open design question.
