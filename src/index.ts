import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "./app";
import { createDb } from "./db/client";
import { getAllMasterVersionReleaseIds, getRelease } from "./discogs-client";
import { createFadeLookupHandler, markFadeLookupFailed } from "./indexing/fade-lookup-handler";
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
  "fade_lookup",
  createFadeLookupHandler({
    db,
    enqueue: (job) => queue.enqueue(job),
    getRelease,
    getMasterVersionReleaseIds: getAllMasterVersionReleaseIds,
  }),
);
queue.onSettled((job) => markFadeLookupFailed(db, job));
queue.start();

const app = createApp({ db, queue });

app.listen(port, () => {
  logger.info(`fader-be listening on http://localhost:${port}`);
  logger.info(`Swagger UI: http://localhost:${port}/docs`);
});
