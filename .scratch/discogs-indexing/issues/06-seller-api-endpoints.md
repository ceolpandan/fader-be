# 06 - Seller API endpoints

Status: done

Depends on: 01, 03, 04, 05 (needs the full pipeline working end-to-end to be meaningful)

Spec: `.scratch/discogs-indexing/spec.md` (Own API section)

## Scope

New Swagger-documented routes (add to `src/docs/openapi.yaml` alongside the existing
`/releases`, `/masters`, `/fade` entries):

- `POST /sellers/:username/index`
  - Generate a fresh `run_id`, upsert `sellers` row (`last_index_status = 'running'`), enqueue
    the first `inventory_page` job (`page: 1`, that `run_id`).
  - `202 Accepted` with `{ username, runId }`.
  - `409 Conflict` if `sellers.last_index_status = 'running'` for this username already — do not
    start a second run.
  - On the run reaching completion (from ticket 04/05's job transitions — see spec's "Run
    completion" rule: no more `inventory_page` jobs pending/processing for the `run_id`, and no
    `release_detail` jobs for it left `pending`/`processing`), flip `sellers.last_index_status`
    to `success`. This detection can be a lightweight check run after each job for that `run_id`
    completes, rather than a separate poller.

- `GET /sellers/:username`
  - `{ username, lastIndexedAt, lastIndexStatus, currentlyRunning, totalReleasesFound,
    releasesEnriched, releasesFailed }`.
  - The three counts: `COUNT(*) GROUP BY status` over `discogs_queue_jobs` where `type =
    'release_detail'` and `run_id` = the seller's current/most recent run.
  - 404 if the username has never been indexed (no `sellers` row).

- `GET /sellers/:username/inventory?status=active|sold|all&page=&pageSize=`
  - Joins `seller_inventory` → `releases` (inner join — rows without a `releases` match yet are
    excluded, per spec).
  - Returns `{ releaseId, title, thumb, year, status, firstSeenAt, soldAt }[]`, plus standard
    pagination metadata.
  - `status` query param defaults to `active`.

## Acceptance criteria

- Calling `POST` twice in a row for the same username while the first run is still in progress
  returns `409` on the second call.
- `GET /sellers/:username` reflects live counts that change as an integration test artificially
  advances job statuses.
- `GET /sellers/:username/inventory` never returns a row whose release isn't yet in `releases`.
- New routes appear in `/docs` (Swagger UI) and `/docs-json`.
