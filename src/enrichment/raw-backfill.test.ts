import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "../db/client";
import { collectionItems, discogsQueueJobs, releaseRaw, releases, wantlistItems } from "../db/schema";
import { DiscogsQueue, RAW_BACKFILL_PRIORITY } from "../queue/discogs-queue";
import { queueRawBackfill, rawBackfillRunId } from "./raw-backfill";

describe("queueRawBackfill", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    queue = new DiscogsQueue(db);
  });

  afterEach(() => {
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  const addRelease = (id: number, extra: Partial<typeof releases.$inferInsert> = {}) =>
    db
      .insert(releases)
      .values({
        id,
        title: `R${id}`,
        genres: [],
        styles: [],
        formats: [],
        artists: [],
        enrichedAt: new Date(),
        ...extra,
      })
      .run();
  const queuedIds = () =>
    db
      .select()
      .from(discogsQueueJobs)
      .orderBy(discogsQueueJobs.id)
      .all()
      .map((job) => (job.payload as { releaseId: number }).releaseId);

  it("queues enriched releases that have no raw response, and no others", () => {
    addRelease(1);
    addRelease(2);
    addRelease(3, { enrichedAt: null });
    addRelease(4, { missingAt: new Date() });
    db.insert(releaseRaw).values({ releaseId: 2, body: "{}", fetchedAt: new Date() }).run();

    const result = queueRawBackfill(db, queue, "u1");

    expect(result).toEqual({ candidates: 1, inCollectorLists: 0, queued: 1 });
    expect(queuedIds()).toEqual([1]);
  });

  it("queues release_detail jobs for the collector at the backfill priority, outside any enrichment run", () => {
    addRelease(1);

    queueRawBackfill(db, queue, "u1");

    expect(db.select().from(discogsQueueJobs).all()).toMatchObject([
      {
        uid: "u1",
        type: "release_detail",
        status: "pending",
        priority: RAW_BACKFILL_PRIORITY,
        runId: rawBackfillRunId("u1"),
        payload: { uid: "u1", releaseId: 1 },
      },
    ]);
    expect(RAW_BACKFILL_PRIORITY).toBeLessThan(0);
  });

  it("queues the collector's wantlist and collection before the rest", () => {
    for (const id of [1, 2, 3, 4, 5]) addRelease(id);
    db.insert(wantlistItems).values({ uid: "u1", releaseId: 4, title: "R4", artists: [] }).run();
    db.insert(collectionItems).values({ uid: "u1", releaseId: 3, title: "R3", artists: [] }).run();
    db.insert(wantlistItems).values({ uid: "other", releaseId: 5, title: "R5", artists: [] }).run();

    const result = queueRawBackfill(db, queue, "u1");

    expect(result).toEqual({ candidates: 5, inCollectorLists: 2, queued: 5 });
    expect(queuedIds()).toEqual([3, 4, 1, 2, 5]);
  });

  it("stops at the limit, keeping the collector's own first", () => {
    for (const id of [1, 2, 3]) addRelease(id);
    db.insert(wantlistItems).values({ uid: "u1", releaseId: 3, title: "R3", artists: [] }).run();

    const result = queueRawBackfill(db, queue, "u1", { limit: 2 });

    expect(result).toEqual({ candidates: 3, inCollectorLists: 1, queued: 2 });
    expect(queuedIds()).toEqual([3, 1]);
  });

  it("only counts on a dry run", () => {
    addRelease(1);
    addRelease(2);

    const result = queueRawBackfill(db, queue, "u1", { dryRun: true });

    expect(result).toEqual({ candidates: 2, inCollectorLists: 0, queued: 0 });
    expect(queuedIds()).toEqual([]);
  });

  it("leaves releases that already have a pending or processing job, and queues a failed one again", () => {
    for (const id of [1, 2, 3, 4]) addRelease(id);
    const job = (releaseId: number, status: "pending" | "processing" | "failed") =>
      db
        .insert(discogsQueueJobs)
        .values({
          uid: "u2",
          runId: "run1",
          type: "release_detail",
          payload: { uid: "u2", releaseId },
          status,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run();
    job(1, "pending");
    job(2, "processing");
    job(3, "failed");

    const result = queueRawBackfill(db, queue, "u1");

    expect(result.candidates).toBe(2);
    expect(queuedIds().slice(3)).toEqual([3, 4]);
  });

  it("is idempotent: a second call queues nothing, and a stored raw row ends a release's turn", () => {
    addRelease(1);
    addRelease(2);

    expect(queueRawBackfill(db, queue, "u1").queued).toBe(2);
    expect(queueRawBackfill(db, queue, "u1")).toEqual({ candidates: 0, inCollectorLists: 0, queued: 0 });

    db.delete(discogsQueueJobs).run();
    db.insert(releaseRaw).values({ releaseId: 1, body: "{}", fetchedAt: new Date() }).run();
    expect(queueRawBackfill(db, queue, "u1").queued).toBe(1);
    expect(queuedIds()).toEqual([2]);
  });
});
