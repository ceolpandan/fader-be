import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(path: string): Db {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  return drizzle(sqlite, { schema });
}

/** A read-only connection for a worker thread; WAL lets it read while the main connection writes. */
export function createReadOnlyDb(path: string): Db {
  const sqlite = new Database(path, { readonly: true });
  sqlite.pragma("busy_timeout = 5000");
  return drizzle(sqlite, { schema });
}
