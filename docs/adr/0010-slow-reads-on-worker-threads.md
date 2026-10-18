# Slow catalogue reads run on worker threads

`better-sqlite3` is synchronous: a query occupies the one Node thread until it returns. A search on the full catalogue (7 GB, `LIKE '%word%'` plus `json_each` over artists, then a second pass for the count) took ~40 s and, meanwhile, no other request was answered and the enrichment queue's timers could not fire.

- **What moved:** `GET /releases` (page, total, faded count) and `GET /enrichment/preview`, the two endpoints that run user-built filters over all releases. They are named ops in `src/read/read-ops.ts`.
- **How:** `src/read/read-runner.ts` keeps a pool of `READ_WORKERS` (default 2) worker threads, each with its own read-only connection (`createReadOnlyDb`; WAL lets them read while the main connection writes). Calls queue FIFO when all workers are busy. A call whose client hung up while it was still queued is dropped, so typing a search does not stack up scans. A scan already running is not interrupted.
- **Tests and tools** use `createInlineReadRunner(db)` (same ops, calling thread); `createApp` defaults to it.
- **Not moved:** `POST /enrichment/run` still scans on the main thread because it reads then writes in one go; it is user-initiated and rare. Move its read half if it hurts.
- **Still slow:** the scan itself. The fix for that is an FTS index on title and artist names, not more threads.
