# df-003: Define release + master endpoint scope

**Epic:** Epic 1 — Backend + Frontend Scaffolding & DTO Pipeline (Issue 3)
**Repo:** fader-be
**Depends on:** df-001
**Blocks:** df-004
**Owner:** you (manual — not agent-automatable, needs product judgment)

## Goal
Write `docs/discogs-endpoints.md`: the fixed reference the sample-capture (df-004) and
DTO-design (df-005) work builds on. Releases + masters only — search is out of scope.

## Steps

1. Create `docs/discogs-endpoints.md` with two sections, one per endpoint.

2. **`GET /releases/{release_id}`** — from the Discogs API v2 release response, decide
   keep vs. discard per field:
   - Likely keep: `id`, `title`, `artists[].name`, `year`, `formats[].name`,
     `labels[].name`, `thumb`, `master_id`, `master_url`, `resource_url`.
   - Likely discard: `notes`, `tracklist` (unless fade feature needs it — check),
     `identifiers`, `videos`, `companies`, `extraartists`, community/rating stats,
     `images` full array (thumb only, or note if full-res needed).
   - Explicitly resolve the ambiguous ones (tracklist, images) — don't leave TBD.

3. **`GET /masters/{master_id}`** — same treatment:
   - Likely keep: `id`, `title`, `main_release`, `year`, `versions_url` (or inline
     `versions[]` if paging isn't needed at this scope), `resource_url`.
   - Likely discard: `styles`, `genres` (unless needed), `tracklist`, `videos`, `notes`.
   - Decide: do we need the full versions list now, or just enough to link out? Note
     the decision + why.

4. For each field kept, one line on *why the extension needs it* — this becomes the
   DTO justification in df-005, don't re-derive it there.

5. Add an explicit line: **"Search endpoint integration is out of scope for this
   epic."**

## Acceptance criteria
- [ ] `docs/discogs-endpoints.md` committed to fader-be
- [ ] Both endpoints listed with a resolved (not TBD) field subset
- [ ] Each kept field has a one-line justification
- [ ] Search explicitly called out as deferred
