# fader-be

Express + SQLite (Drizzle) API that indexes Discogs seller inventories and serves them to `fader-ui` (sibling repo at `../fader-ui`) and the Discogs Fader extension. Commands and layout: `README.md`.

## Issue tracker

GitHub issues, all filed in `fader-ui` (even backend work). Reference them as `fader-ui#<n>` in commits. `.scratch/` holds the archived indexing spec only; write no new tickets there.

## Git workflow

Branch `<type>/<issue-id>-<short-description>`: `feature`, `bugfix` or `chore`; max 5 hyphenated words; issue id optional. Same convention as `fader-ui`.

## Verification

Run `npm test`, `npm run typecheck` and `npm run lint` before declaring done. CI runs typecheck, lint and build.

## Changes that reach fader-ui

- `src/docs/openapi.yaml` is hand-written and is the contract `fader-ui` generates its client from (`/docs-json`). Update it in the same commit as any route, query param or DTO change; nothing derives it from the code.
- Schema changes: edit `src/db/schema.ts`, then `npm run db:generate` and commit the SQL under `drizzle/`.
- After an API change, `fader-ui` runs `npm run generate:api` against this server running on `localhost:3000`.
- Every route requires a Firebase ID token (`firebase-auth` middleware).

For a feature spanning both repos: backend first (DTO + `openapi.yaml` + tests), then the UI branch.

## Agent skills

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`. Use the `CONTEXT.md` terms in names, commits and issues.

When a change adds or renames a domain concept, or makes a decision someone would otherwise have to dig out of an issue comment, update `CONTEXT.md` or add an ADR under `docs/adr/` in the same change. Issues are the working record; `CONTEXT.md` and the ADRs are the current truth.
