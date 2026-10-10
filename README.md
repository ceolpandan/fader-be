# fader-be

Backend service for the Discogs Fader extension. Owns our own DTOs and acts as the
boundary between the extension and Discogs' API — the extension never calls Discogs
directly. Only exposes what the extension needs (release/master id, title, thumb,
etc.), not Discogs' full payloads.

Stores the releases it fetches in a local database, through a Discogs-rate-limited
request queue, and lists and filters them for `fader-ui`. This is the `main-tou` branch,
which has no seller, inventory or listing features (see `docs/adr/0005-main-tou-branch.md`).

## Run locally

```
npm install
npm run db:migrate
npm run dev
```

Server starts on `http://localhost:3000` (override with `PORT`).

- Swagger UI: `http://localhost:3000/docs`
- Raw OpenAPI spec (JSON): `http://localhost:3000/docs-json`
- Health check: `http://localhost:3000/health`

### Discogs proxy endpoints

- `GET /releases/:id` — proxies `https://api.discogs.com/releases/:id`
- `GET /masters/:id` — proxies `https://api.discogs.com/masters/:id`
- `POST /fade` — resolves a release/master id to every sibling id that should fade together

### Stored releases

- `GET /releases` — paginated, filterable list of the stored releases (`?page=&pageSize=&sort=` and the filters)
- `GET /releases/facets` — the genres, styles, formats and countries of the releases a filter leaves
- `POST /releases/:id/refresh` — re-fetch one release from Discogs

Set `DISCOGS_TOKEN` (personal access token from
https://www.discogs.com/settings/developers) to raise Discogs' rate limit.
Unauthenticated requests work but are limited to 25/min. `DB_PATH` controls where the
SQLite database file lives (defaults to `./data/fader.sqlite`).

## Scripts

- `npm run dev` — start with hot reload (`ts-node-dev`)
- `npm run build` — compile to `dist/`
- `npm start` — run compiled `dist/index.js`
- `npm test` — run the test suite (Vitest)
- `npm run test:watch` — Vitest in watch mode
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — ESLint over `src/`
- `npm run db:generate` — generate a Drizzle migration from `src/db/schema.ts`
- `npm run db:migrate` — apply migrations to the SQLite file at `DB_PATH`

## Layout

```
src/
  index.ts           entrypoint: wires the db, queue, job handlers, starts the server
  app.ts             express app + middleware wiring
  discogs-client.ts  fetch wrapper for the real Discogs API
  db/                Drizzle schema (releases, fades, master_versions,
                     discogs_queue_jobs, user_settings) + db client
  queue/             generic rate-limited, durable job queue (DiscogsQueue)
  indexing/          queue job handlers: release detail, fade lookup
  routes/            releases.ts, masters.ts, fade.ts, settings.ts
  types/             raw Discogs API response types
  dto/               our DTOs (all Discogs release/master fields kept for now) + mappers
  docs/              openapi.yaml served via Swagger UI
drizzle/             generated SQL migrations — source of truth for the DB schema
```
