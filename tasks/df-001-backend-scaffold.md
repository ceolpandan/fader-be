# df-001: Backend repo scaffold

**Epic:** Epic 1 — Backend + Frontend Scaffolding & DTO Pipeline (Issue 1)
**Repo:** fader-be
**Depends on:** none
**Blocks:** df-003, df-004, df-005

## Goal
Node.js + TypeScript service skeleton, Swagger UI mounted on a placeholder spec, CI stub.

## Steps

1. **Init project**
   - `npm init -y`
   - `npm i express`
   - `npm i -D typescript ts-node-dev @types/node @types/express`
   - `npx tsc --init` then set in `tsconfig.json`:
     - `"target": "ES2022"`, `"module": "commonjs"`, `"outDir": "dist"`, `"rootDir": "src"`
     - `"strict": true`, `"esModuleInterop": true`, `"skipLibCheck": true`

2. **Folder layout**
   ```
   src/
     index.ts          # entrypoint, starts express app
     app.ts             # express app + middleware wiring
     routes/            # route handlers (empty for now)
     docs/
       openapi.placeholder.yaml
   docs/
     discogs-endpoints.md   # created in df-003
     samples/                # created in df-004
     dto-notes.md             # created in df-005
   ```

3. **Placeholder OpenAPI spec** — `src/docs/openapi.placeholder.yaml`:
   ```yaml
   openapi: 3.0.3
   info:
     title: discogs-fade-backend
     version: 0.0.0-placeholder
   paths: {}
   ```

4. **Swagger UI**
   - `npm i swagger-ui-express js-yaml`
   - `npm i -D @types/swagger-ui-express`
   - In `app.ts`: load the YAML file with `js-yaml`, mount at `GET /docs` via `swaggerUi.setup(spec)`.
   - Also expose raw JSON at `GET /docs-json` (needed later by df-006's AutoRest step).

5. **Scripts** (`package.json`):
   - `"dev": "ts-node-dev --respawn --transpile-only src/index.ts"`
   - `"build": "tsc -p ."`
   - `"start": "node dist/index.js"`
   - `"lint": "eslint . --ext .ts"`
   - `"typecheck": "tsc --noEmit"`

6. **Lint** — `npm i -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin`, minimal `.eslintrc.cjs` extending `plugin:@typescript-eslint/recommended`.

7. **README.md** — purpose (DTO boundary between extension and Discogs API), `npm run dev`, where `/docs` lives, repo layout.

8. **CI stub** — `.github/workflows/ci.yml`:
   ```yaml
   name: CI
   on: [pull_request]
   jobs:
     build:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: 20 }
         - run: npm ci
         - run: npm run typecheck
         - run: npm run lint
         - run: npm run build
   ```

9. `.gitignore`: `node_modules`, `dist`.

## Acceptance criteria
- [ ] `npm run dev` starts server with hot reload
- [ ] `GET /docs` renders Swagger UI against placeholder spec
- [ ] `GET /docs-json` returns the spec as JSON
- [ ] `npm run build && npm run typecheck && npm run lint` all pass
- [ ] README committed
- [ ] CI workflow runs build/lint/typecheck on PR
