# 07 - Sold inventory auto-purge

Status: done

Depends on: 01 (seller_inventory table)

Spec: `.scratch/discogs-indexing/spec.md` (`seller_inventory` refresh semantics — 30-day purge)

## Scope

A periodic cleanup task (e.g. run once at boot and then every few hours via `setInterval`,
consistent with the in-process worker style used by the queue in ticket 03 — no external cron
needed for now) that deletes any `seller_inventory` row where `status = 'sold'` and `sold_at` is
more than 30 days old.

This is independent of manual early deletion of sold rows (mentioned as wanted, but per the
spec's "Deferred" section the manual-delete mechanism itself is just a plain delete — not
designed further here; skip building a dedicated endpoint for it unless asked).

## Acceptance criteria

- A `seller_inventory` row with `status = 'sold'` and `sold_at` 31+ days ago is deleted by the
  purge task.
- A row with `status = 'sold'` and `sold_at` within the last 30 days is left alone.
- `status = 'active'` rows are never touched by this task regardless of any timestamp.
