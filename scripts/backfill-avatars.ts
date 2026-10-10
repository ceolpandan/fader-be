import "dotenv/config";
import { eq, isNull } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { sellers } from "../src/db/schema";
import { DiscogsRateLimitError, getUserProfile } from "../src/discogs-client";

/** One-off: stores the Discogs avatar for sellers indexed before it was saved. No re-scan. */
const DELAY_MS = 1100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const dbPath = process.env.DB_PATH ?? "./data/fader.sqlite";
  const db = createDb(dbPath);
  const rows = db.select({ username: sellers.username }).from(sellers).where(isNull(sellers.avatarUrl)).all();
  console.log(`${rows.length} seller(s) without an avatar in ${dbPath}`);

  let stored = 0;
  for (const { username } of rows) {
    try {
      const profile = await getUserProfile(username);
      const avatarUrl = profile.avatar_url || null;
      if (avatarUrl) {
        db.update(sellers).set({ avatarUrl }).where(eq(sellers.username, username)).run();
        stored += 1;
      }
      console.log(`${username}: ${avatarUrl ? "stored" : "no avatar on Discogs"}`);
    } catch (err) {
      console.warn(`${username}: skipped (${String(err)})`);
      if (err instanceof DiscogsRateLimitError) await sleep(err.retryAfterMs ?? 60_000);
    }
    await sleep(DELAY_MS);
  }
  console.log(`Done: ${stored} of ${rows.length} stored`);
}

void main();
