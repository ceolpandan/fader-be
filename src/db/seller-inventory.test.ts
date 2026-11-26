import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "./client";
import { sellerInventory } from "./schema";

describe("seller_inventory table", () => {
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

  it("persists and reads back a seller_inventory row", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const row = {
      sellerUsername: "some-seller",
      releaseId: 732194,
      status: "active" as const,
      firstSeenAt: now,
      lastSeenAt: now,
      soldAt: null,
    };

    db.insert(sellerInventory).values(row).run();

    const [result] = db
      .select()
      .from(sellerInventory)
      .where(
        and(
          eq(sellerInventory.sellerUsername, row.sellerUsername),
          eq(sellerInventory.releaseId, row.releaseId),
        ),
      )
      .all();

    expect(result).toEqual(row);
  });

  it("rejects a duplicate (seller_username, release_id) pair", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const row = {
      sellerUsername: "some-seller",
      releaseId: 732194,
      status: "active" as const,
      firstSeenAt: now,
      lastSeenAt: now,
      soldAt: null,
    };

    db.insert(sellerInventory).values(row).run();

    expect(() => db.insert(sellerInventory).values(row).run()).toThrow();
  });
});
