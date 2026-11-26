import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "../db/client";
import { sellerInventory } from "../db/schema";
import {
  purgeSoldInventory,
  startSoldInventoryPurgeLoop,
  DEFAULT_PURGE_INTERVAL_MS,
} from "./sold-inventory-purge";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("sold inventory purge", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-31T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  function seedRow(releaseId: number, status: "active" | "sold", soldAt: Date | null) {
    const now = new Date();
    db.insert(sellerInventory)
      .values({
        sellerUsername: "some-seller",
        releaseId,
        status,
        firstSeenAt: now,
        lastSeenAt: now,
        soldAt,
      })
      .run();
  }

  describe("purgeSoldInventory", () => {
    it("deletes a sold row whose sold_at is more than 30 days old", () => {
      seedRow(1, "sold", new Date(Date.now() - 31 * DAY_MS));

      const deletedCount = purgeSoldInventory(db);

      expect(deletedCount).toBe(1);
      const rows = db.select().from(sellerInventory).where(eq(sellerInventory.releaseId, 1)).all();
      expect(rows).toHaveLength(0);
    });

    it("leaves a sold row alone if sold_at is within the last 30 days", () => {
      seedRow(2, "sold", new Date(Date.now() - 29 * DAY_MS));

      purgeSoldInventory(db);

      const rows = db.select().from(sellerInventory).where(eq(sellerInventory.releaseId, 2)).all();
      expect(rows).toHaveLength(1);
    });

    it("never touches active rows regardless of any timestamp", () => {
      seedRow(3, "active", null);

      purgeSoldInventory(db);

      const rows = db.select().from(sellerInventory).where(eq(sellerInventory.releaseId, 3)).all();
      expect(rows).toHaveLength(1);
    });
  });

  describe("startSoldInventoryPurgeLoop", () => {
    it("purges immediately on start, then again every interval", () => {
      seedRow(1, "sold", new Date(Date.now() - 31 * DAY_MS));

      const stop = startSoldInventoryPurgeLoop(db);

      expect(db.select().from(sellerInventory).where(eq(sellerInventory.releaseId, 1)).all()).toHaveLength(0);

      seedRow(2, "sold", new Date(Date.now() - 31 * DAY_MS));
      expect(db.select().from(sellerInventory).where(eq(sellerInventory.releaseId, 2)).all()).toHaveLength(1);

      vi.advanceTimersByTime(DEFAULT_PURGE_INTERVAL_MS);

      expect(db.select().from(sellerInventory).where(eq(sellerInventory.releaseId, 2)).all()).toHaveLength(0);

      stop();
    });
  });
});
