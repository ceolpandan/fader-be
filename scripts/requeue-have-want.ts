import "dotenv/config";
import { createDb } from "../src/db/client";
import { discogsTokens } from "../src/db/schema";
import { startHaveWantBackfill } from "../src/enrichment/enrichment-run";
import { DiscogsQueue } from "../src/queue/discogs-queue";

// Queues a release_detail job for every release enriched before haves and wants were stored.
// The queue is not started here: restart the server and it carries the run out with the
// collector's token (1.1 s per release). Usage: npm run db:requeue-have-want -- [uid]
const db = createDb(process.env.DB_PATH ?? "./data/fader.sqlite");

let uid = process.argv[2];
if (!uid) {
  const collectors = db.select({ uid: discogsTokens.uid }).from(discogsTokens).all();
  if (collectors.length !== 1) {
    console.error(`Pass the collector's uid: ${collectors.length} collectors have a Discogs token.`);
    process.exit(1);
  }
  uid = collectors[0]!.uid;
}

const result = startHaveWantBackfill(db, new DiscogsQueue(db), uid);
if ("conflict" in result) {
  console.error("An enrichment run is already active for this collector; cancel it or let it finish first.");
  process.exit(1);
}
if (!("run" in result)) throw new Error("Unexpected result");
console.log(`Queued ${result.run.total} releases for ${uid}. Start the server to fetch them.`);
