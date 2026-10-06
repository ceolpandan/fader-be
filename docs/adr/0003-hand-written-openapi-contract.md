# The OpenAPI spec is hand-written and is the contract

`src/docs/openapi.yaml` is written by hand and served at `/docs-json`; nothing derives it from the routes or DTOs. `fader-ui` generates its API client from it, so the spec is what a consumer sees, and it is reviewed and updated in the same commit as any route, query param or DTO change.

We chose this over generating the spec from code so the contract changes deliberately and reads cleanly for consumers. The cost is that the spec can drift from the code if a change forgets it.
