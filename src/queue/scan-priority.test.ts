import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createDb, type Db } from "../db/client";
import { DiscogsQueue, INLINE_PRIORITY, PACING_MS, SCAN_PRIORITY } from "./discogs-queue";

describe("DiscogsQueue scan priority", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    queue = new DiscogsQueue(db);
    vi.useFakeTimers();
  });

  afterEach(() => {
    queue.stop();
    vi.useRealTimers();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  const record = () => {
    const order: string[] = [];
    queue.registerHandler(
      "inventory_page",
      vi.fn(async (payload: { page: number }) => {
        order.push(`page-${payload.page}`);
      }),
    );
    queue.registerHandler(
      "release_detail",
      vi.fn(async (payload: { releaseId: number }) => {
        order.push(`release-${payload.releaseId}`);
      }),
    );
    return order;
  };
  const scanPage = (page: number, uid = "u1") =>
    queue.enqueue({
      runId: "scan",
      type: "inventory_page",
      payload: { uid, username: "a", page, runStartedAt: "2026-01-01T00:00:00.000Z" },
      priority: SCAN_PRIORITY,
    });
  const detail = (releaseId: number, uid = "u1", priority = 0) =>
    queue.enqueue({ runId: "enrich", type: "release_detail", payload: { uid, releaseId }, priority });

  it("gives enrichment a turn after every SCAN_BURST scan jobs, instead of waiting for the scan to end", async () => {
    const order = record();
    detail(1);
    detail(2);
    for (let page = 1; page <= 8; page += 1) scanPage(page);

    queue.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PACING_MS * 9);

    expect(order).toEqual([
      "page-1", "page-2", "page-3", "release-1",
      "page-4", "page-5", "page-6", "release-2",
      "page-7", "page-8",
    ]);
  });

  it("keeps scanning when no enrichment is waiting", async () => {
    const order = record();
    for (let page = 1; page <= 5; page += 1) scanPage(page);

    queue.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PACING_MS * 4);

    expect(order).toEqual(["page-1", "page-2", "page-3", "page-4", "page-5"]);
  });

  it("still lets an inline job go ahead of the scan", async () => {
    const order = record();
    for (let page = 1; page <= 4; page += 1) scanPage(page);
    detail(9, "u1", INLINE_PRIORITY);

    queue.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PACING_MS * 4);

    expect(order[0]).toBe("release-9");
  });

  it("counts the burst per collector, so another collector's scan does not use up a turn", async () => {
    const order = record();
    detail(1, "u2");
    for (let page = 1; page <= 4; page += 1) scanPage(page, "u2");
    for (let page = 11; page <= 13; page += 1) scanPage(page, "u1");

    queue.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PACING_MS * 4);

    // u2's lane runs three pages, then its enrichment; u1's three pages run alongside on their own lane.
    expect(order.filter((entry) => entry === "release-1")).toHaveLength(1);
    expect(order.indexOf("release-1")).toBeGreaterThanOrEqual(3);
    expect(order).toEqual(expect.arrayContaining(["page-11", "page-12", "page-13"]));
  });
});
