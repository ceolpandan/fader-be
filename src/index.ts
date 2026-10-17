import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "./app";
import { createDb } from "./db/client";
import { getDiscogsToken } from "./db/discogs-tokens";
import {
  getAllMasterVersionReleaseIds,
  getCollectionCount,
  getRelease,
  getWantlistCount,
  searchFirstReleaseId,
} from "./discogs-client";
import { failRun, finishRunsWithNothingLeft, finishRunWhenSettled } from "./enrichment/enrichment-run";
import { createDiscogsProfileHandler } from "./indexing/discogs-profile-handler";
import { createFadeLookupHandler, markFadeLookupFailed } from "./indexing/fade-lookup-handler";
import { createReleaseDetailHandler } from "./indexing/release-detail-handler";
import { DiscogsQueue } from "./queue/discogs-queue";
import { createScrapeSearchHandler, failScrapeSearches, settleScrapeSearch } from "./scrapes/scrape-search";
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
    getToken: (uid) => getDiscogsToken(db, uid),
    getRelease,
    getMasterVersionReleaseIds: getAllMasterVersionReleaseIds,
  }),
);
queue.registerHandler(
  "release_detail",
  createReleaseDetailHandler({ db, getToken: (uid) => getDiscogsToken(db, uid), getRelease }),
);
queue.registerHandler(
  "discogs_profile",
  createDiscogsProfileHandler({
    db,
    getToken: (uid) => getDiscogsToken(db, uid),
    getCollectionCount,
    getWantlistCount,
  }),
);
queue.onSettled((job) => markFadeLookupFailed(db, job));
queue.registerHandler(
  "scrape_search",
  createScrapeSearchHandler({ db, queue, getToken: (uid) => getDiscogsToken(db, uid), searchFirstReleaseId }),
);
queue.onSettled((job) => finishRunWhenSettled(db, job));
queue.onSettled((job) => settleScrapeSearch(db, job));
queue.onRunAborted((runId, cause) => failRun(db, runId, cause));
queue.onRunAborted((runId) => failScrapeSearches(db, runId));
// Runs and their jobs are stored, so a run the server stopped in the middle of carries on.
finishRunsWithNothingLeft(db);
queue.start();

const app = createApp({ db, queue });

app.listen(port, () => {
  logger.info(`fader-be listening on http://localhost:${port}`);
  logger.info(`Swagger UI: http://localhost:${port}/docs`);
});
