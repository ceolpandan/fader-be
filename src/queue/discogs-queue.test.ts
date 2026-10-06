import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createDb, type Db } from "../db/client";
import { discogsQueueJobs } from "../db/schema";
import { DiscogsQueue, NonRetryableError, PACING_MS, QueueWaitTimeoutError } from "./discogs-queue";

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

  it("paces two consecutive jobs PACING_MS apart, serially", async () => {
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

  it("runs a higher-priority job before earlier-enqueued lower-priority jobs, keeping id order among equals", async () => {
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

    queue.enqueue({ runId: "run-1", type: "inventory_page", payload: { username: "a", page: 1 } });
    queue.enqueue({ runId: "run-1", type: "inventory_page", payload: { username: "a", page: 2 } });
    queue.enqueue({ runId: "run-2", type: "release_detail", payload: { releaseId: 7 }, priority: 10 });

    queue.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PACING_MS * 2);

    expect(order).toEqual(["release-7", "page-1", "page-2"]);
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

  it("lets a priority job cut in mid-run, then resumes background jobs in order", async () => {
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
    for (const page of [1, 2, 3]) {
      queue.enqueue({ runId: "run-1", type: "inventory_page", payload: { username: "a", page } });
    }

    queue.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["page-1"]);

    const inline = queue.enqueueAndWait({
      runId: "inline",
      type: "release_detail",
      payload: { releaseId: 7 },
    });
    await vi.advanceTimersByTimeAsync(PACING_MS * 3);
    await inline;

    expect(order).toEqual(["page-1", "release-7", "page-2", "page-3"]);
  });

  describe("enqueueAndWait", () => {
    it("resolves once the handler succeeds, jumping ahead of pending background jobs", async () => {
      const order: string[] = [];
      queue.registerHandler(
        "inventory_page",
        vi.fn(async () => {
          order.push("page");
        }),
      );
      queue.registerHandler(
        "release_detail",
        vi.fn(async () => {
          order.push("release");
        }),
      );
      queue.enqueue({ runId: "run-1", type: "inventory_page", payload: { username: "a", page: 1 } });

      const waiting = queue.enqueueAndWait({
        runId: "inline-1",
        type: "release_detail",
        payload: { releaseId: 7 },
      });
      queue.start();
      await vi.advanceTimersByTimeAsync(0);

      await expect(waiting).resolves.toBeUndefined();
      expect(order).toEqual(["release"]);
    });

    it("rejects with the original NonRetryableError on a permanent failure", async () => {
      const failure = new NonRetryableError("release not found");
      queue.registerHandler(
        "release_detail",
        vi.fn(async () => {
          throw failure;
        }),
      );

      const waiting = queue.enqueueAndWait({
        runId: "inline-1",
        type: "release_detail",
        payload: { releaseId: 7 },
      });
      const outcome = waiting.catch((err: unknown) => err);
      queue.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(await outcome).toBe(failure);
    });

    it("rejects with QueueWaitTimeoutError after timeoutMs, while the job still runs and completes later", async () => {
      const handler = vi.fn(async () => {});
      queue.registerHandler("release_detail", handler);

      const waiting = queue.enqueueAndWait(
        { runId: "inline-1", type: "release_detail", payload: { releaseId: 7 } },
        { timeoutMs: 1000 },
      );
      const outcome = waiting.catch((err: unknown) => err);

      // Queue not started yet, so the job just sits pending past the deadline.
      await vi.advanceTimersByTimeAsync(1000);
      expect(await outcome).toBeInstanceOf(QueueWaitTimeoutError);
      expect(handler).not.toHaveBeenCalled();

      queue.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(handler).toHaveBeenCalledTimes(1);
      const [row] = db.select().from(discogsQueueJobs).all();
      expect(row!.status).toBe("done");
    });

    it("coalesces concurrent identical requests onto one job, and enqueues fresh after it settles", async () => {
      const handler = vi.fn(async () => {});
      queue.registerHandler("release_detail", handler);
      const request = () =>
        queue.enqueueAndWait({
          runId: "inline",
          type: "release_detail",
          payload: { releaseId: 7 },
        });

      const first = request();
      const second = request();
      queue.start();
      await vi.advanceTimersByTimeAsync(0);
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(db.select().from(discogsQueueJobs).all()).toHaveLength(1);

      const third = request();
      await vi.advanceTimersByTimeAsync(PACING_MS);
      await third;

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("rejects every coalesced caller when the shared job fails", async () => {
      const failure = new NonRetryableError("gone");
      queue.registerHandler(
        "release_detail",
        vi.fn(async () => {
          throw failure;
        }),
      );
      const request = () =>
        queue
          .enqueueAndWait({ runId: "inline", type: "release_detail", payload: { releaseId: 7 } })
          .catch((err: unknown) => err);

      const outcomes = Promise.all([request(), request()]);
      queue.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(await outcomes).toEqual([failure, failure]);
    });

    it("rejects with the last error once retries are exhausted", async () => {
      const handler = vi.fn(async () => {
        throw new Error("discogs is down");
      });
      queue.registerHandler("release_detail", handler);

      const waiting = queue.enqueueAndWait({
        runId: "inline-1",
        type: "release_detail",
        payload: { releaseId: 7 },
      });
      const outcome = waiting.catch((err: unknown) => err);
      queue.start();
      await vi.advanceTimersByTimeAsync(15_000);

      expect(handler).toHaveBeenCalledTimes(3);
      expect(await outcome).toEqual(new Error("discogs is down"));
    });
  });
});
