# 05 - release_detail job handler

Status: done

Depends on: 03 (queue infrastructure), 01 (releases table). Existing `getRelease` in
`discogs-client.ts` is reused as-is, no changes needed there.

Spec: `.scratch/discogs-indexing/spec.md` (`releases` table definition, and the "Deferred"
section — no artist enrichment)

## Scope

Register the `release_detail` handler with the queue from ticket 03. Payload: `{ releaseId }`.

On execution:
1. Call the existing `getRelease(releaseId)`.
2. Map the raw Discogs response to exactly the `releases` column set from the spec: `id, title,
   year, country, genres, styles, formats (name+descriptions only, drop qty), master_id, thumb,
   rating_average (community.rating.average), rating_count (community.rating.count), haves
   (community.have), wants (community.want), label_ids (labels[].id only), artists ({id, name}[]
   — drop anv and every other stub field)`.
3. Upsert into `releases` (insert if new; this handler only ever runs for ids that weren't
   already present, per ticket 04's dedup, but upsert defensively rather than assuming that
   invariant holds).
4. A 404 from `getRelease` (release delisted from Discogs entirely) should not retry — treat it
   as a terminal failure for this job (mark `failed` immediately, don't burn the retry budget on
   something that will never succeed).

## Acceptance criteria

- Given a realistic raw Discogs release fixture, the resulting `releases` row has exactly the
  spec'd columns populated correctly, and no extra fields leak through (confirms the mapper
  isn't just spreading the raw object, unlike the current `mapReleaseToDto`).
- A 404 fails the job on the first attempt, no retries.
- A transient error (simulated network failure) goes through the normal 3-attempt retry path
  from ticket 03.
