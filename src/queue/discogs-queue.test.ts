import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createDb, type Db } from "../db/client";
import { discogsQueueJobs } from "../db/schema";
import { DiscogsQueue, NonRetryableError, PACING_MS } from "./discogs-queue";

describe("DiscogsQueue", () => {
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

  it("processes an enqueued job through a registered handler and marks it done", async () => {
    const handler = vi.fn(async () => {});
    queue.registerHandler("inventory_page", handler);

    const jobId = queue.enqueue({
      runId: "run-1",
      type: "inventory_page",
      payload: { username: "some-seller", page: 1 },
    });

    queue.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).toHaveBeenCalledWith(
      { username: "some-seller", page: 1 },
      { runId: "run-1", jobId },
    );

    const [row] = db.select().from(discogsQueueJobs).where(eq(discogsQueueJobs.id, jobId)).all();
    expect(row!.status).toBe("done");
  });

  it("paces two consecutive jobs ~1017ms apart, serially", async () => {
    const invokedAt: number[] = [];
    const handler = vi.fn(async () => {
      invokedAt.push(Date.now());
    });
    queue.registerHandler("inventory_page", handler);

    queue.enqueue({ runId: "run-1", type: "inventory_page", payload: { username: "a", page: 1 } });
    queue.enqueue({ runId: "run-1", type: "inventory_page", payload: { username: "a", page: 2 } });

    queue.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PACING_MS);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(invokedAt[1]! - invokedAt[0]!).toBe(PACING_MS);

    const rows = db.select().from(discogsQueueJobs).all();
    expect(rows.every((row) => row.status === "done")).toBe(true);
  });

  it("retries a failing handler up to 3 attempts, then marks the job failed", async () => {
    const handler = vi.fn(async () => {
      throw new Error("discogs is down");
    });
    queue.registerHandler("inventory_page", handler);

    const jobId = queue.enqueue({
      runId: "run-1",
      type: "inventory_page",
      payload: { username: "a", page: 1 },
    });

    queue.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(handler).toHaveBeenCalledTimes(3);

    const [row] = db.select().from(discogsQueueJobs).where(eq(discogsQueueJobs.id, jobId)).all();
    expect(row!.status).toBe("failed");
    expect(row!.attempts).toBe(3);
    expect(row!.errorMessage).toBe("discogs is down");
  });

  it("fails a job immediately on NonRetryableError, without using up the retry budget", async () => {
    const handler = vi.fn(async () => {
      throw new NonRetryableError("release not found");
    });
    queue.registerHandler("release_detail", handler);

    const jobId = queue.enqueue({
      runId: "run-1",
      type: "release_detail",
      payload: { releaseId: 732194 },
    });

    queue.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).toHaveBeenCalledTimes(1);

    const [row] = db.select().from(discogsQueueJobs).where(eq(discogsQueueJobs.id, jobId)).all();
    expect(row!.status).toBe("failed");
    expect(row!.attempts).toBe(1);
    expect(row!.errorMessage).toBe("release not found");
  });

  it("resets a job stuck in processing back to pending on start (crash recovery)", async () => {
    const now = new Date();
    const [stuck] = db
      .insert(discogsQueueJobs)
      .values({
        runId: "run-1",
        type: "inventory_page",
        payload: { username: "a", page: 1, runStartedAt: now.toISOString() },
        status: "processing",
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all();

    queue.start();

    // recoverStuckJobs runs synchronously inside start(), before the first tick
    // (scheduled via setTimeout) ever fires — no need to advance fake timers here.
    const [row] = db
      .select()
      .from(discogsQueueJobs)
      .where(eq(discogsQueueJobs.id, stuck!.id))
      .all();
    expect(row!.status).toBe("pending");
  });

  it("notifies onSettled listeners when a job reaches a terminal state (done or failed), not on retry", async () => {
    const settled: string[] = [];
    queue.onSettled((job) => settled.push(`${job.type}:${job.status}`));

    queue.registerHandler("inventory_page", vi.fn(async () => {}));
    queue.registerHandler(
      "release_detail",
      vi.fn(async () => {
        throw new NonRetryableError("nope");
      }),
    );

    queue.enqueue({ runId: "run-1", type: "inventory_page", payload: { username: "a", page: 1 } });
    queue.enqueue({ runId: "run-1", type: "release_detail", payload: { releaseId: 1 } });

    queue.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PACING_MS);

    expect(settled).toEqual(["inventory_page:done", "release_detail:failed"]);
  });
});
