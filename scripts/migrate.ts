import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const dbPath = process.env.DB_PATH ?? "./data/fader.sqlite";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const sqlite = new Database(dbPath);
const db = drizzle(sqlite);

migrate(db, { migrationsFolder: "./drizzle" });

// Dropped tables leave their rows in the file's free pages until the file is rebuilt.
sqlite.exec("VACUUM");

console.log(`Migrations applied to ${dbPath}`);
