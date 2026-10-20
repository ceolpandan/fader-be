import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import * as yaml from "js-yaml";
import swaggerUi from "swagger-ui-express";
import type { Db } from "./db/client";
import { firebaseAuth } from "./middleware/firebase-auth";
import { requestLogger } from "./middleware/request-logger";
import type { DiscogsQueue } from "./queue/discogs-queue";
import { createInlineReadRunner, type ReadRunner } from "./read/read-runner";
import { createDiscogsProfileRouter } from "./routes/discogs-profile";
import { createWantlistRouter } from "./routes/wantlist";
import { createWantlistFoldersRouter } from "./routes/wantlist-folders";
import { createDiscogsTokenRouter } from "./routes/discogs-token";
import { createEnrichmentRouter } from "./routes/enrichment";
import { createFadeRouter } from "./routes/fade";
import { createMastersRouter } from "./routes/masters";
import { createReleasesRouter } from "./routes/releases";
import { createSavedFiltersRouter } from "./routes/saved-filters";
import { createScrapesRouter } from "./routes/scrapes";
import { createSettingsRouter } from "./routes/settings";
import { logger } from "./util/logger";

const openapiPath = path.join(__dirname, "docs", "openapi.yaml");
const openapiSpec = yaml.load(fs.readFileSync(openapiPath, "utf8")) as Record<string, unknown>;

export interface AppDeps {
  db: Db;
  queue: DiscogsQueue;
  /** Where the slow release queries run; defaults to the calling thread (the server passes a worker pool). */
  readRunner?: ReadRunner;
  /** How long `POST /fade` waits for the fade's lookup before answering `pending`. */
  fadeLookupWaitMs?: number;
  /** Asks Discogs who a token belongs to; defaults to the real API. */
  getIdentity?: (token: string) => Promise<{ id: number; username: string }>;
}

export function createApp(appDeps: AppDeps): Express {
  const deps = { ...appDeps, readRunner: appDeps.readRunner ?? createInlineReadRunner(appDeps.db) };
  const app = express();

  app.use(cors({ origin: "http://localhost:4200" }));
  app.use(requestLogger);
  // An uploaded scrape is up to 512 KB of text, above the default 100 KB limit.
  app.use(express.json({ limit: "1mb" }));

  app.get("/docs-json", (_req, res) => {
    res.json(openapiSpec);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(firebaseAuth);

  app.use("/releases", createReleasesRouter(deps));
  app.use("/masters", createMastersRouter(deps));
  app.use("/enrichment", createEnrichmentRouter(deps));
  app.use("/fade", createFadeRouter(deps));
  app.use("/saved-filters", createSavedFiltersRouter(deps));
  app.use("/scrapes", createScrapesRouter(deps));
  app.use("/me/discogs-profile", createDiscogsProfileRouter(deps));
  app.use("/wantlist/folders", createWantlistFoldersRouter(deps));
  app.use("/wantlist", createWantlistRouter(deps));
  app.use("/settings/discogs-token", createDiscogsTokenRouter(deps));
  app.use("/settings", createSettingsRouter(deps));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- express requires 4-arg error handlers
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("Unhandled error", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
