import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "./client";
import { releases } from "./schema";

describe("releases table", () => {
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

  it("persists and reads back all columns of a release row", () => {
    const row = {
      id: 732194,
      title: "Stockholm",
      year: 1998,
      country: "Sweden",
      genres: ["Electronic"],
      styles: ["Deep House"],
      formats: [{ name: "Vinyl", descriptions: ["12\"", "33 1/3 RPM"] }],
      masterId: 12345,
      thumb: "https://example.com/thumb.jpg",
      ratingAverage: 4.5,
      ratingCount: 20,
      haves: 100,
      wants: 50,
      labelIds: [1, 2],
      artists: [{ id: 1, name: "The Persuader" }],
    };

    db.insert(releases).values(row).run();

    const [result] = db.select().from(releases).where(eq(releases.id, row.id)).all();

    expect(result).toEqual(row);
  });
});
