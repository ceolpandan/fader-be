# df-004: Capture real Discogs response samples

**Epic:** Epic 1 — Backend + Frontend Scaffolding & DTO Pipeline (Issue 4)
**Repo:** fader-be
**Depends on:** df-003
**Blocks:** df-005
**Owner:** you / agent task against live Discogs API

## Goal
Call the two endpoints scoped in df-003 against real Discogs data, save representative
raw JSON so df-005's DTO design isn't guessing at shape.

## Steps

1. **Auth** — Discogs requires a `User-Agent` header and, for higher rate limits, a
   personal access token (`Authorization: Discogs token=...`). Get a token from
   https://www.discogs.com/settings/developers, store as `DISCOGS_TOKEN` env var
   locally (not committed).

2. **Pick sample IDs** — need variety, not just the first result you find:
   - Release **with** a master (has `master_id`/`master_url` populated)
   - Release **without** a master (standalone, no `master_id`)
   - Master with **many** versions (large `versions` count)
   - Master with **few/one** version

3. **Fetch** — simple script (`scripts/capture-samples.ts`, run via `ts-node`, not
   part of the app build) hitting:
   - `https://api.discogs.com/releases/{id}`
   - `https://api.discogs.com/masters/{id}`
   with the `User-Agent` + token header. Save each raw response, pretty-printed.

4. **Save to** `docs/samples/`:
   ```
   docs/samples/
     release-with-master.json
     release-without-master.json
     master-many-versions.json
     master-few-versions.json
   ```

5. **Notes doc** — `docs/samples/NOTES.md`: record anything inconsistent across
   samples — null vs. missing fields, fields that are sometimes empty arrays,
   `master_id` present but `master_url` absent (or vice versa), rate-limit behavior
   hit while capturing.

## Acceptance criteria
- [ ] 4 sample JSON files saved under `docs/samples/` per the variety above
- [ ] `docs/samples/NOTES.md` documents inconsistencies/nulls/edge cases
- [ ] Capture script not wired into the app's build/runtime (dev-only tool)
- [ ] No token committed to the repo
