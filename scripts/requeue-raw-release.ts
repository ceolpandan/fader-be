import "dotenv/config";
import { createDb } from "../src/db/client";
import { discogsTokens } from "../src/db/schema";
import { queueRawBackfill } from "../src/enrichment/raw-backfill";
import { DiscogsQueue } from "../src/queue/discogs-queue";

// Queues a release_detail job for every enriched release that has no release_raw row yet
// (fader-ui#151), the collector's wantlist and collection first. The queue is not started here:
// restart the server and it carries the jobs out with the collector's token (1.1 s per release).
// Rerun it after a stop or a failure: it queues only what is still missing.
// Usage: npm run db:requeue-raw -- [uid] [--limit N] [--dry-run]
const db = createDb(process.env.DB_PATH ?? "./data/fader.sqlite");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitAt = args.indexOf("--limit");
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : undefined;
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
  console.error("--limit needs a whole number of at least 1.");
  process.exit(1);
}
let uid = args.find((arg, index) => !arg.startsWith("--") && index !== limitAt + 1);
if (!uid) {
  const collectors = db.select({ uid: discogsTokens.uid }).from(discogsTokens).all();
  if (collectors.length !== 1) {
    console.error(`Pass the collector's uid: ${collectors.length} collectors have a Discogs token.`);
    process.exit(1);
  }
  uid = collectors[0]!.uid;
}

const result = queueRawBackfill(db, new DiscogsQueue(db), uid, { limit, dryRun });
console.log(
  `${result.candidates} releases need their raw response (${result.inCollectorLists} in ${uid}'s wantlist or collection).`,
);
console.log(dryRun ? "Dry run: nothing queued." : `Queued ${result.queued}. Start the server to fetch them.`);
