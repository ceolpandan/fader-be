# Architecture diagrams

Branch `chore/architecture-diagrams`, merged into `main` on 2026-10-16. The frontend's counterpart is in `fader-ui` (`CHANGELOG.md`).

- `docs/architecture/flows.md`: the backend flows as sequence diagrams.
- `docs/architecture/modules.mmd`: the module graph, generated with `npm run docs:deps`.
- `docs/architecture/schema.dbml` and `schema.svg`: the database tables, relations and indexes, generated with `npm run docs:db` and `npm run docs:db:svg`. Regenerate them after a schema change.
- `.dependency-cruiser.cjs` and `npm run deps:check`: module boundary rules (the data layer must not import routes).
