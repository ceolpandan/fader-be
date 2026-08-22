# Phase 1

Scaffolding + first working fade flow (Discogs search page only).

## Backend (fader-be)
- Express + TS scaffold, CI (typecheck/lint/build), Swagger UI at `/docs`
- Release/master DTOs (unscoped, all Discogs fields kept for now) + hand-authored OpenAPI spec
- `GET /releases/:id`, `GET /masters/:id` proxy Discogs, mapped to our DTOs
- `POST /fade`: given a `releaseId` or `masterId`, resolves the master and walks all
  sibling versions -> full id set to fade
- `DISCOGS_TOKEN` via `.env` (dotenv), appended to Discogs requests

## Frontend (fader-fe)
- MV3 extension scaffold, esbuild build/watch
- Content script: detects release + master cards on the Discogs search page, hover
  "Fade" button on each
- Fade action calls backend `/fade` (via background service worker, avoids CORS),
  hides the release/master + all siblings, persists ids in `chrome.storage.local`
- AutoRest-generated TS client (`src/api/generated`) from the backend's OpenAPI spec,
  `npm run generate-client` to regenerate

## Known gaps / deferred
- No sample Discogs responses captured to docs
- DTOs hand-written, not generated from spec; no scoping/trim-down pass yet
- No unfade UI (faded cards just disappear)
- Search page only; release/master detail pages not covered yet
