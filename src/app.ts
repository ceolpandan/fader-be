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
import { createFadeRouter } from "./routes/fade";
import { mastersRouter } from "./routes/masters";
import { createReleasesRouter } from "./routes/releases";
import { createSellersRouter, type DiscogsReads } from "./routes/sellers";
import { createSettingsRouter } from "./routes/settings";
import { logger } from "./util/logger";

const openapiPath = path.join(__dirname, "docs", "openapi.yaml");
const openapiSpec = yaml.load(fs.readFileSync(openapiPath, "utf8")) as Record<string, unknown>;

export interface AppDeps {
  db: Db;
  queue: DiscogsQueue;
  /** Direct Discogs reads for the seller preview; defaults to the real client. */
  discogs?: DiscogsReads;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.use(cors({ origin: "http://localhost:4200" }));
  app.use(requestLogger);
  app.use(express.json());

  app.get("/docs-json", (_req, res) => {
    res.json(openapiSpec);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(firebaseAuth);

  app.use("/releases", createReleasesRouter(deps));
  app.use("/masters", mastersRouter);
  app.use("/fade", createFadeRouter(deps));
  app.use("/sellers", createSellersRouter(deps));
  app.use("/settings", createSettingsRouter(deps));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- express requires 4-arg error handlers
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("Unhandled error", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
