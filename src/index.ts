import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "./app";
import { createDb } from "./db/client";
import { getInventory, getRelease, getUserProfile } from "./discogs-client";
import { createInventoryPageHandler } from "./indexing/inventory-page-handler";
import { createSellerProfileHandler } from "./indexing/seller-profile-handler";
import { createReleaseDetailHandler } from "./indexing/release-detail-handler";
import { checkRunCompletion, failOrphanedRuns, markRunAborted } from "./indexing/run-completion";
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
  createInventoryPageHandler({
    db,
    enqueue: (job) => queue.enqueue(job),
    getInventory,
    getUserProfile,
  }),
);
queue.registerHandler("release_detail", createReleaseDetailHandler({ db, getRelease }));
queue.registerHandler(
  "seller_profile",
  createSellerProfileHandler({ db, enqueue: (job) => queue.enqueue(job), getUserProfile }),
);
queue.onSettled((job) => checkRunCompletion(db, job.runId));
queue.onRunAborted((runId) => markRunAborted(db, runId));
queue.start();
const orphaned = failOrphanedRuns(db);
if (orphaned > 0) logger.warn(`Marked ${orphaned} orphaned running seller(s) as error`);

startSoldInventoryPurgeLoop(db);

const app = createApp({ db, queue });

app.listen(port, () => {
  logger.info(`fader-be listening on http://localhost:${port}`);
  logger.info(`Swagger UI: http://localhost:${port}/docs`);
});
