# 03 - Rate-limited queue infrastructure

Status: done

Depends on: 01 (needs `discogs_queue_jobs` table)

Spec: `.scratch/discogs-indexing/spec.md` (Queue / worker design section)

## Scope

Generic job-queue mechanics — no knowledge of "inventory" or "release" specifics here, those
land in tickets 04/05 as job type handlers registered against this infrastructure.

- Enqueue: insert a row into `discogs_queue_jobs` (`run_id`, `type`, `payload`, `status:
  'pending'`, `attempts: 0`).
- Worker loop: on a fixed ~1017ms interval (60000/59), claim the oldest `pending` job (by `id`),
  mark it `processing`, dispatch to the registered handler for its `type`, then mark `done` or —
  on handler error — increment `attempts` and either re-queue as `pending` (if `attempts < 3`,
  with exponential backoff starting ~2s before it's eligible again) or mark `failed` with
  `error_message` set.
- Handler registration: a small registry (`type -> handler fn`) so tickets 04/05 can plug in
  without touching this ticket's code.
- Boot recovery: on process start, reset any row still `status = 'processing'` back to `pending`
  (a previous run died mid-request).
- Log every job transition using the existing colored logger conventions
  (`src/util/logger.ts` / `src/middleware/request-logger.ts`) — include `run_id`, `type`, `id`.
- Start the worker loop once, at app boot (`src/index.ts`), alongside the HTTP server.

## Acceptance criteria

- Two jobs enqueued back-to-back are processed with the ~1017ms pacing between Discogs-bound
  handler invocations (verify via timestamps in a test using a fake handler, not real Discogs
  calls).
- A handler that throws is retried up to 3 times total, then lands in `failed` with
  `error_message` populated.
- A job manually left in `processing` before restart is `pending` again after the boot recovery
  step runs.
- No handler logic for `inventory_page` or `release_detail` yet — those are out of scope here.
