# Phase 2

Discogs seller inventory indexing: given a seller's username, fetch their full
marketplace inventory and enrich each release, respecting Discogs' rate limit, into
a local database.

## Backend (fader-be)
- SQLite (via Drizzle ORM) — first database in the project; migrations in `drizzle/`
- `releases`, `sellers`, `seller_inventory`, `discogs_queue_jobs` tables
- Generic rate-limited, durable request queue (`DiscogsQueue`): strict serial pacing
  at 59 req/min, 3-attempt retry with exponential backoff, crash recovery
  (`processing` -> `pending` on restart), settle-notification hook
- `inventory_page` job: paginates a seller's inventory, dedups against already-known
  releases, upserts `seller_inventory` (active/sold diff runs on the last page)
- `release_detail` job: fetches and maps a release to our trimmed column set,
  upserts into `releases`; 404s fail without retrying
- `POST /sellers/:username/index`, `GET /sellers/:username` (status + live
  progress), `GET /sellers/:username/inventory` (paginated, active/sold/all)
- Sold listings auto-purge after 30 days

## Known gaps / deferred
- No `artists`/`labels` tables yet — releases only keep a `{id, name}` artist stub
  and bare label ids, no country or full profile data
- Postgres migration (SQLite is fine for now; schema is Drizzle-portable)
- Queue worker still runs in-process; no separate worker process yet
- No frontend UI for this yet (exercised via curl/Swagger only) — an Angular
  dashboard is planned later

## Ideas for later
- A labels table, so we know which country a given label is from
