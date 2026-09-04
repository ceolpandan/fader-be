# 01 - DB schema and Drizzle setup

Status: done

Spec: `.scratch/discogs-indexing/spec.md` (Database section)

## Scope

Introduce the database layer for this project (none exists yet — no ORM/driver dependency
currently in `package.json`).

- Add Drizzle ORM + SQLite driver as dependencies.
- Define the four tables exactly as specified in the spec's Database section:
  - `releases`
  - `seller_inventory`
  - `sellers`
  - `discogs_queue_jobs`
- Set up Drizzle's migration mechanism (migration folder + generate/apply scripts in
  `package.json`), and a SQLite file path configurable via an env var (add to `.env.example`
  alongside the existing `DISCOGS_TOKEN`).
- A small db-client module (e.g. `src/db/client.ts`) that other modules import to get a
  connected Drizzle instance — no schema-per-caller duplication.

## Acceptance criteria

- Running the migration against a fresh empty SQLite file creates all four tables with the exact
  columns/types from the spec.
- `npm run typecheck` and `npm run lint` pass.
- No other feature code depends on this ticket for it to be reviewable on its own — it only adds
  schema, no business logic.
