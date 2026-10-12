import type Database from "better-sqlite3";

/**
 * Sets `releases.version_count` to the number of stored releases under each master, and back to 1
 * for releases without one. The importer calls it after the load; call it again after anything
 * else adds or removes releases.
 */
export function refreshVersionCounts(sqlite: Database.Database): void {
  sqlite.transaction(() => {
    sqlite.exec(`UPDATE releases SET version_count = 1 WHERE master_id IS NULL AND version_count <> 1`);
    sqlite.exec(
      `WITH counts AS (SELECT master_id, count(*) AS n FROM releases WHERE master_id IS NOT NULL GROUP BY master_id)
       UPDATE releases SET version_count = (SELECT n FROM counts WHERE counts.master_id = releases.master_id)
       WHERE master_id IS NOT NULL`,
    );
  })();
}
