# 04 - inventory_page job handler

Status: done

Depends on: 02 (getInventory), 03 (queue infrastructure), 01 (seller_inventory/releases tables)

Spec: `.scratch/discogs-indexing/spec.md` (Queue / worker design — "Inventory pagination —
chained, not pre-enqueued" section)

## Scope

Register the `inventory_page` handler with the queue from ticket 03. Payload: `{ username,
page }`, carries the job's `run_id`.

On execution:
1. Call `getInventory(username, page)`.
2. For every listing's `release.id` not already present in `releases`, enqueue a
   `release_detail` job (`payload: { releaseId }`, same `run_id`).
3. Upsert `seller_inventory` rows for every `release.id` on this page: `status = 'active'`,
   `last_seen_at = now`, `sold_at = null` (clears it if this was a relisted item), and
   `first_seen_at = now` only on insert (don't overwrite on update).
4. If the response's pagination has a `next` link, enqueue the next `inventory_page` job
   (`page + 1`, same `run_id`).
5. If there's no `next` link (last page for this run): run the sold-diff pass — every
   `seller_inventory` row for this `username` with `last_seen_at` older than this run's start
   timestamp gets `status = 'sold'`, `sold_at = now` (only if not already `sold`).

Also: `POST /sellers/:username/index` (ticket 06) is what enqueues the very first
`inventory_page` job (page 1) with a freshly generated `run_id` — that wiring belongs to ticket
06, not here; this ticket is just the handler.

## Acceptance criteria

- A mocked two-page inventory (page 1 has a `next` link, page 2 doesn't) results in: page 2 job
  auto-enqueued after page 1 processes, and the sold-diff pass runs only after page 2 processes.
- A release id already present in `releases` does not get a duplicate `release_detail` job
  enqueued.
- A `seller_inventory` row not touched by a run (simulate a previously-active id absent from the
  new inventory) ends the run as `status = 'sold'` with `sold_at` set.
- A `seller_inventory` row previously `sold` that reappears in this run's inventory flips back to
  `active` with `sold_at` cleared.
