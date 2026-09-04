import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "./client";
import { sellers } from "./schema";

describe("sellers table", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
  });

  afterEach(() => {
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  it("persists and reads back a seller row", () => {
    const row = {
      username: "some-seller",
      lastIndexedAt: null,
      lastIndexStatus: "never" as const,
      currentRunId: null,
    };

    db.insert(sellers).values(row).run();

    const [result] = db.select().from(sellers).where(eq(sellers.username, row.username)).all();

    expect(result).toEqual(row);
  });
});
