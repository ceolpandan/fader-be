import "dotenv/config";
import Database from "better-sqlite3";
import { dedupeVideos } from "../src/db/dedupe-videos";
import type { ReleaseVideo } from "../src/db/schema";

// Rewrites the videos of every release that lists the same link more than once so each link is stored
// once (fader-ui#62). Only those rows are touched. Stop the server first, and back up the database.
// Usage: npm run db:dedupe-videos -- [--dry-run]
const dryRun = process.argv.includes("--dry-run");
const db = new Database(process.env.DB_PATH ?? "./data/fader.sqlite");

const duplicated = db
  .prepare(
    `SELECT id, videos FROM releases
     WHERE videos != '[]'
       AND json_array_length(videos) > (SELECT count(DISTINCT json_extract(j.value, '$.src')) FROM json_each(releases.videos) j)`,
  )
  .all() as { id: number; videos: string }[];

let removed = 0;
const update = db.prepare("UPDATE releases SET videos = ? WHERE id = ?");
const rewrite = db.transaction((rows: { id: number; videos: string }[]) => {
  for (const { id, videos } of rows) {
    const before = JSON.parse(videos) as ReleaseVideo[];
    const after = dedupeVideos(before);
    removed += before.length - after.length;
    if (!dryRun) update.run(JSON.stringify(after), id);
  }
});
rewrite(duplicated);

console.log(`${dryRun ? "Would rewrite" : "Rewrote"} ${duplicated.length} releases, removing ${removed} duplicate links.`);
