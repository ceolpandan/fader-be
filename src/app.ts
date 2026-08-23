import fs from "node:fs";
import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import yaml from "js-yaml";
import swaggerUi from "swagger-ui-express";
import { requestLogger } from "./middleware/request-logger";
import { fadeRouter } from "./routes/fade";
import { mastersRouter } from "./routes/masters";
import { releasesRouter } from "./routes/releases";
import { logger } from "./util/logger";

const openapiPath = path.join(__dirname, "docs", "openapi.yaml");
const openapiSpec = yaml.load(fs.readFileSync(openapiPath, "utf8")) as Record<string, unknown>;

export function createApp(): Express {
  const app = express();

  app.use(requestLogger);
  app.use(express.json());

  app.get("/docs-json", (_req, res) => {
    res.json(openapiSpec);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));

  app.use("/releases", releasesRouter);
  app.use("/masters", mastersRouter);
  app.use("/fade", fadeRouter);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- express requires 4-arg error handlers
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("Unhandled error", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
