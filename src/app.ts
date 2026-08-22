import fs from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import yaml from "js-yaml";
import swaggerUi from "swagger-ui-express";
import { mastersRouter } from "./routes/masters";
import { releasesRouter } from "./routes/releases";

const openapiPath = path.join(__dirname, "docs", "openapi.yaml");
const openapiSpec = yaml.load(fs.readFileSync(openapiPath, "utf8")) as Record<string, unknown>;

export function createApp(): Express {
  const app = express();

  app.use(express.json());

  app.get("/docs-json", (_req, res) => {
    res.json(openapiSpec);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));

  app.use("/releases", releasesRouter);
  app.use("/masters", mastersRouter);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}
