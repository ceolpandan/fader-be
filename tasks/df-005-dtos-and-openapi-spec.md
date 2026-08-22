# df-005: Decide DTOs, author OpenAPI spec, implement endpoints

**Epic:** Epic 1 — Backend + Frontend Scaffolding & DTO Pipeline (Issue 5)
**Repo:** fader-be
**Depends on:** df-004
**Blocks:** df-006

## Goal
Schema-first: DTOs decided → OpenAPI spec authored by hand → TS types generated from
spec → route handlers implemented against generated types. Spec is the source of
truth; code must conform to it, not the reverse.

## Steps

1. **DTO design** — using `docs/samples/*.json` + `docs/discogs-endpoints.md`, write
   `docs/dto-notes.md` defining:
   - `ReleaseDetailDto`: flattened shape (e.g. `artists: string[]` not the raw
     artist-object array; `label: string` not `labels[]` unless multi-label matters).
   - `MasterDetailDto`: same treatment.
   - Explicitly note: search-result DTO deferred to later epic.
   - For each field, map raw Discogs field → DTO field, note any transform (e.g.
     joining artist names, picking first label).

2. **Author `openapi.yaml`** (replaces `src/docs/openapi.placeholder.yaml`):
   - `components.schemas.ReleaseDetailDto`, `MasterDetailDto` matching df-005 step 1.
   - `paths./releases/{id}.get` → 200 response `ReleaseDetailDto`, 404 schema.
   - `paths./masters/{id}.get` → 200 response `MasterDetailDto`, 404 schema.
   - Path param `id` typed `integer`.

3. **Generate TS types from spec** (don't hand-write):
   - `npm i -D openapi-typescript`
   - `"generate-types": "openapi-typescript src/docs/openapi.yaml -o src/types/api.d.ts"`
   - Add to `build` script as a pre-step so types can't silently drift.

4. **Implement route handlers** — `src/routes/releases.ts`, `src/routes/masters.ts`:
   - Fetch raw Discogs response (reuse fetch logic from df-004's capture script,
     promote it to `src/discogs-client.ts`).
   - Map raw → DTO per `docs/dto-notes.md`, typed against `src/types/api.d.ts`.
   - Wire into `app.ts`.

5. **Swap Swagger UI source** — point `/docs` at `openapi.yaml` instead of the
   placeholder from df-001.

6. **Manual verification** — hit `/docs`, confirm rendered spec matches actual
   `curl localhost:PORT/releases/{id}` / `/masters/{id}` behavior.

## Acceptance criteria
- [ ] `docs/dto-notes.md` committed, written before the spec
- [ ] `openapi.yaml` defines both DTOs as schemas + both endpoint shapes
- [ ] `/docs` serves `openapi.yaml`, placeholder removed
- [ ] `src/types/api.d.ts` generated via `openapi-typescript`, not hand-written
- [ ] `/releases/{id}` and `/masters/{id}` implemented, mapping raw → DTO using
      generated types
- [ ] Manual check: Swagger UI matches real endpoint behavior
