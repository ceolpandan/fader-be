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

## Scripts

- `npm run dev` — start with hot reload (`ts-node-dev`)
- `npm run build` — compile to `dist/`
- `npm start` — run compiled `dist/index.js`
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — ESLint over `src/`

## Layout

```
src/
  index.ts    entrypoint, starts the server
  app.ts      express app + middleware wiring
  docs/       OpenAPI spec served via Swagger UI (placeholder for now, see tasks/df-005)
docs/         project docs (endpoint scope, samples, DTO notes — see tasks/)
tasks/        df-xxx implementation task docs for this repo
```
