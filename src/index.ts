import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "./app";
import { createDb } from "./db/client";
import { getInventory, getRelease } from "./discogs-client";
import { createInventoryPageHandler } from "./indexing/inventory-page-handler";
import { createReleaseDetailHandler } from "./indexing/release-detail-handler";
import { checkRunCompletion } from "./indexing/run-completion";
import { startSoldInventoryPurgeLoop } from "./indexing/sold-inventory-purge";
import { DiscogsQueue } from "./queue/discogs-queue";
import { logger } from "./util/logger";

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", err);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", reason);
});

const port = Number(process.env.PORT) || 3000;

const dbPath = process.env.DB_PATH ?? "./data/fader.sqlite";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = createDb(dbPath);

const queue = new DiscogsQueue(db);
queue.registerHandler(
  "inventory_page",
  createInventoryPageHandler({ db, enqueue: (job) => queue.enqueue(job), getInventory }),
);
queue.registerHandler("release_detail", createReleaseDetailHandler({ db, getRelease }));
queue.onSettled((job) => checkRunCompletion(db, job.runId));
queue.start();

startSoldInventoryPurgeLoop(db);

const app = createApp({ db, queue });

app.listen(port, () => {
  logger.info(`fader-be listening on http://localhost:${port}`);
  logger.info(`Swagger UI: http://localhost:${port}/docs`);
});
