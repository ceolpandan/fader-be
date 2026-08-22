# fader-be

Backend service for the Discogs Fader extension. Owns our own DTOs and acts as the
boundary between the extension and Discogs' API — the extension never calls Discogs
directly. Only exposes what the extension needs (release/master id, title, thumb,
etc.), not Discogs' full payloads.

## Run locally

```
npm install
npm run dev
```

Server starts on `http://localhost:3000` (override with `PORT`).

- Swagger UI: `http://localhost:3000/docs`
- Raw OpenAPI spec (JSON): `http://localhost:3000/docs-json`
- Health check: `http://localhost:3000/health`
- `GET /releases/:id` — proxies `https://api.discogs.com/releases/:id`
- `GET /masters/:id` — proxies `https://api.discogs.com/masters/:id`

Set `DISCOGS_TOKEN` (personal access token from
https://www.discogs.com/settings/developers) to raise Discogs' rate limit.
Unauthenticated requests work but are limited to 25/min.

## Scripts

- `npm run dev` — start with hot reload (`ts-node-dev`)
- `npm run build` — compile to `dist/`
- `npm start` — run compiled `dist/index.js`
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — ESLint over `src/`

## Layout

```
src/
  index.ts          entrypoint, starts the server
  app.ts            express app + middleware wiring
  discogs-client.ts fetch wrapper for the real Discogs API
  routes/           releases.ts, masters.ts — our endpoints
  types/            raw Discogs API response types
  dto/              our DTOs (all fields kept for now — see tasks/df-003) + mappers
  docs/             openapi.yaml served via Swagger UI
tasks/              df-xxx implementation task docs for this repo
```
