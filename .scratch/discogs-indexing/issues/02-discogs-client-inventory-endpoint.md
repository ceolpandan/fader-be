# 02 - Discogs client: getInventory

Status: done

Spec: `.scratch/discogs-indexing/spec.md` (Discogs wrapper layer section)

## Scope

Extend the existing `src/discogs-client.ts` (native `fetch`, personal-access-token auth via
`DISCOGS_TOKEN`) with a new method:

```ts
getInventory(username: string, page: number): Promise<DiscogsInventoryPage>
```

- Calls `GET /users/{username}/inventory?page={page}&per_page=100`.
- `per_page=100` is Discogs' documented maximum — always use it.
- Add the raw response shape to `src/types/discogs-api.ts` (mirroring the existing
  `DiscogsRelease`/`DiscogsMaster` pattern): pagination object (`page`, `pages`, `per_page`,
  `items`, `urls: {first, last, prev, next}`) plus each listing's fields — importantly
  `release: {id, resource_url, catalog_number, year, description}`.
- This is internal only — no new HTTP route, no Swagger entry (per the agreed scope: Discogs
  wrappers stay internal, only our own API is Swagger-documented).
- No rate-limiting logic here — that's the queue's job (ticket 03). This method is a plain,
  single-request wrapper, same level of abstraction as the existing `getRelease`/`getMaster`.

## Acceptance criteria

- `getInventory('someuser', 1)` returns a typed object matching the new interface.
- 404 (unknown username) throws the existing `DiscogsNotFoundError`, consistent with
  `getRelease`/`getMaster`.
- Unit test with a mocked fetch response covering the pagination fields and at least one listing
  item's `release.id`.
