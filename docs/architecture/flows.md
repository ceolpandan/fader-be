# Backend flows

Sequence diagrams of the operations that matter when judging a rewrite. Written from the code
(`src/routes/fade.ts`, `src/enrichment/enrichment-run.ts`, `src/queue/discogs-queue.ts`,
`src/indexing/*`); update them when those change. GitHub renders the Mermaid blocks.

Companion files: `schema.dbml` (tables, indexes; `npm run docs:db`), `modules.mmd` (module
graph; `npm run docs:deps`), and the system overview in the `fader-ui` repo
(`docs/architecture/overview.md`).

## Process shape

One Node process: Express (HTTP), a `DiscogsQueue` (in-memory lanes over a SQLite job table), and
`better-sqlite3` (synchronous, in-process). There is no separate worker, so a slow synchronous
query blocks HTTP and the queue alike.

```mermaid
flowchart LR
  UI[fader-ui / fader-fe] -->|HTTP + Firebase ID token| EX[Express routes]
  EX --> DB[(SQLite, better-sqlite3)]
  EX -->|enqueue| Q[DiscogsQueue lanes, one per collector]
  Q <-->|job rows| DB
  Q -->|paced requests| D[Discogs API]
  Q --> H[Job handlers: indexing/*]
  H --> DB
```

## Browse releases (the hot read path)

`GET /releases` parses the filter query, builds a Drizzle `WHERE` and runs it against `releases`
and the side tables. This is the path where the schema's composite and expression indexes
(`schema.dbml`) decide the cost, not the language.

```mermaid
sequenceDiagram
  participant UI as fader-ui
  participant MW as cors, logger, firebaseAuth
  participant R as routes/releases
  participant Q as parseReleaseQuery
  participant DB as SQLite
  UI->>MW: GET /releases?filters&sort&page
  MW->>MW: verify Firebase ID token (firebase-admin)
  MW->>R: req.user.uid
  R->>Q: parse and validate query
  Q-->>R: WHERE parts, sort, page
  R->>DB: COUNT matching (not missing, not faded for uid)
  R->>DB: SELECT page (same WHERE, ORDER BY, LIMIT, OFFSET)
  R->>DB: COUNT faded (for the fadedCount badge)
  DB-->>R: total, rows, fadedCount
  R-->>UI: ReleaseListDto
```

## Fade (user waits for a lookup)

`POST /fade` answers immediately when the master is already known. Otherwise it stores the fade
as `pending`, enqueues a lookup and **polls the fades table every 200 ms for up to 20 s**
(`awaitLookup`), answering `pending` if the lookup has not settled.

```mermaid
sequenceDiagram
  participant UI as fader-ui
  participant R as routes/fade
  participant DB as SQLite
  participant Q as DiscogsQueue
  participant H as fade-lookup-handler
  participant D as Discogs
  UI->>R: POST /fade {releaseId | masterId}
  R->>DB: resolveFade (releases, master_versions)
  alt master and versions already stored
    R->>DB: upsert fade (done)
    R-->>UI: FadeResponseDto
  else lookup needed
    R->>DB: upsert fade (pending)
    R->>Q: enqueue fade_lookup (high priority)
    loop every 200 ms, up to 20 s
      R->>DB: read fade.lookupStatus
    end
    Q->>H: run job (after lane pacing)
    H->>D: get release, then master versions
    D-->>H: data
    H->>DB: store master_versions, update fade (done or failed)
    R-->>UI: FadeResponseDto (done, failed or pending)
  end
```

## Enrichment run (the long background job)

A run turns an Explore filter into one `release_detail` job per release, then drains them at the
lane's pacing. Run and job state live in SQLite, so a restart resumes them (`index.ts` calls
`finishRunsWithNothingLeft` and `queue.start`). Throughput is capped by Discogs pacing, not by CPU.

```mermaid
sequenceDiagram
  participant UI as fader-ui
  participant R as routes/enrichment
  participant E as enrichment-run
  participant DB as SQLite
  participant Q as DiscogsQueue
  participant H as release-detail-handler
  participant D as Discogs
  UI->>R: POST /enrichment/run {query, fresh}
  R->>E: startRun
  E->>DB: select releases in scope (filters, not faded, not enriched, not already queued)
  E->>DB: insert enrichment_runs and one discogs_queue_jobs row per release
  E->>Q: wake lane
  R-->>UI: 201 run
  loop each job, paced
    Q->>DB: claim next pending job
    Q->>H: handler(payload)
    H->>D: GET release
    alt 200
      H->>DB: upsert release (rating, details)
      Q->>DB: job done
    else 404 on last attempt
      H->>DB: mark missing, enrichment_not_found
    else 429 or network error
      Q->>Q: pause lane, backoff 1, 2, 4, 8, 10 min
    else 5xx
      Q->>Q: retry at normal pace, set aside after 3 tries
    end
    Q->>E: onSettled, finishRunWhenSettled
  end
  UI->>R: GET /enrichment/run (poll for progress)
```

## What the diagrams suggest for a rewrite

These are hypotheses to check with measurements (see fader-ui issue for tracing), not findings.

- `GET /releases` runs three queries per request (total, page, faded count); the two counts are
  `COUNT`s over a filtered set, a candidate for caching or cheaper counting.
- Enrichment and fade lookups wait on Discogs pacing and the rate limit, so a faster language
  changes almost nothing there.
- The read path is bound by SQLite and its indexes. The SQL and the schema move with you; the
  language matters less than keeping the same indexes and query shapes.
- The import (`src/import`, XML dump) is the likeliest CPU-bound code; profile it first.
- The 200 ms polling in `awaitLookup` and the single process holding queue state in memory are
  design choices to revisit in a rewrite regardless of language.
- The OpenAPI file (`src/docs/openapi.yaml`, ADR 0003) is the contract a rewrite must keep.
