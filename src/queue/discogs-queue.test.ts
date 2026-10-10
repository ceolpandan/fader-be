import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createDb, type Db } from "../db/client";
import { discogsQueueJobs } from "../db/schema";
import { DiscogsAuthError, DiscogsRateLimitError, DiscogsTransientError } from "../discogs-client";
import {
  DiscogsQueue,
  MAX_CAP_RETRIES,
  MAX_TRANSIENT_ATTEMPTS,
  NonRetryableError,
  PACING_MS,
  QueueUnavailableError,
  QueueWaitTimeoutError,
} from "./discogs-queue";

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
    queue.registerHandler("fade_lookup", handler);

    const jobId = queue.enqueue({
      runId: "run-1",
      type: "fade_lookup",
      payload: { uid: "u", kind: "release", id: 1 },
    });

    queue.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).toHaveBeenCalledWith(
      { uid: "u", kind: "release", id: 1 },
      { runId: "run-1", jobId, attempt: 1 },
    );

    const [row] = db.select().from(discogsQueueJobs).where(eq(discogsQueueJobs.id, jobId)).all();
    expect(row!.status).toBe("done");
  });

  it("paces two consecutive jobs PACING_MS apart, serially", async () => {
    const invokedAt: number[] = [];
    const handler = vi.fn(async () => {
      invokedAt.push(Date.now());
    });
    queue.registerHandler("fade_lookup", handler);

    queue.enqueue({ runId: "run-1", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 1 } });
    queue.enqueue({ runId: "run-1", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 2 } });

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
    queue.registerHandler("fade_lookup", handler);

    const jobId = queue.enqueue({
      runId: "run-1",
      type: "fade_lookup",
      payload: { uid: "u", kind: "release", id: 1 },
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
      "fade_lookup",
      vi.fn(async (payload: { id: number }) => {
        order.push(`page-${payload.id}`);
      }),
    );
    queue.registerHandler(
      "release_detail",
      vi.fn(async (payload: { releaseId: number }) => {
        order.push(`release-${payload.releaseId}`);
      }),
    );

    queue.enqueue({ runId: "run-1", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 1 } });
    queue.enqueue({ runId: "run-1", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 2 } });
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
        type: "fade_lookup",
        payload: { uid: "u", kind: "release", id: 1 },
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

    queue.registerHandler("fade_lookup", vi.fn(async () => {}));
    queue.registerHandler(
      "release_detail",
      vi.fn(async () => {
        throw new NonRetryableError("nope");
      }),
    );

    queue.enqueue({ runId: "run-1", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 1 } });
    queue.enqueue({ runId: "run-1", type: "release_detail", payload: { releaseId: 1 } });

    queue.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PACING_MS);

    expect(settled).toEqual(["fade_lookup:done", "release_detail:failed"]);
  });

  it("lets a priority job cut in mid-run, then resumes background jobs in order", async () => {
    const order: string[] = [];
    queue.registerHandler(
      "fade_lookup",
      vi.fn(async (payload: { id: number }) => {
        order.push(`page-${payload.id}`);
      }),
    );
    queue.registerHandler(
      "release_detail",
      vi.fn(async (payload: { releaseId: number }) => {
        order.push(`release-${payload.releaseId}`);
      }),
    );
    for (const page of [1, 2, 3]) {
      queue.enqueue({ runId: "run-1", type: "fade_lookup", payload: { uid: "u", kind: "release", id: page } });
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
        "fade_lookup",
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
      queue.enqueue({ runId: "run-1", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 1 } });

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

  describe("pausing on transient Discogs errors", () => {
    const MIN = 60_000;
    const status = (id: number) =>
      db.select().from(discogsQueueJobs).where(eq(discogsQueueJobs.id, id)).all()[0]!;

    /** A handler that throws `err` for the first `failures` calls, then succeeds. */
    function flaky(failures: number, err: Error) {
      let calls = 0;
      return vi.fn(async () => {
        calls += 1;
        if (calls <= failures) throw err;
      });
    }

    it("retries the same job after 1 min, without using up its attempts", async () => {
      const handler = flaky(1, new DiscogsTransientError("boom"));
      queue.registerHandler("release_detail", handler);
      const id = queue.enqueue({ runId: "a", type: "release_detail", payload: { releaseId: 1 } });

      queue.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(status(id)).toMatchObject({ status: "pending", attempts: 0 });

      await vi.advanceTimersByTimeAsync(MIN - 1);
      expect(handler).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(status(id).status).toBe("done");
    });

    it("pauses every run, not just the failing job's", async () => {
      const handler = flaky(1, new DiscogsTransientError("boom"));
      queue.registerHandler("release_detail", handler);
      queue.enqueue({ runId: "a", type: "release_detail", payload: { releaseId: 1 } });
      queue.enqueue({ runId: "b", type: "release_detail", payload: { releaseId: 2 } });

      queue.start();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("backs off 1, 2, 4, 8 then 10 min, and resets to 1 min after a success", async () => {
      const handler = flaky(5, new DiscogsTransientError("boom"));
      queue.registerHandler("fade_lookup", handler);
      queue.enqueue({ runId: "a", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 1 } });
      queue.start();
      await vi.advanceTimersByTimeAsync(0);

      const waits: number[] = [];
      for (let call = 1; call <= 5; call++) {
        const pause = queue.getPause()!;
        waits.push(Math.round((pause.retryAt.getTime() - Date.now()) / MIN));
        await vi.advanceTimersByTimeAsync(pause.backoffMs);
      }
      expect(waits).toEqual([1, 2, 4, 8, 10]);
      expect(handler).toHaveBeenCalledTimes(6);
      expect(queue.getPause()).toBeNull();

      // the next failure starts over at 1 min
      queue.registerHandler("fade_lookup", flaky(1, new DiscogsTransientError("again")));
      queue.enqueue({ runId: "a", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 2 } });
      await vi.advanceTimersByTimeAsync(PACING_MS);
      expect(queue.getPause()!.backoffMs).toBe(MIN);
    });

    it("waits for Retry-After when it is longer than the backoff step", async () => {
      queue.registerHandler("release_detail", flaky(1, new DiscogsRateLimitError("slow down", 5 * MIN)));
      queue.enqueue({ runId: "a", type: "release_detail", payload: { releaseId: 1 } });

      queue.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(queue.getPause()!.backoffMs).toBe(5 * MIN);
    });

    it("ignores a Retry-After shorter than the backoff step", async () => {
      queue.registerHandler("release_detail", flaky(1, new DiscogsRateLimitError("slow down", 5_000)));
      queue.enqueue({ runId: "a", type: "release_detail", payload: { releaseId: 1 } });

      queue.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(queue.getPause()!.backoffMs).toBe(MIN);
    });

    it("keeps failing a 404 permanently and does not pause", async () => {
      queue.registerHandler("release_detail", async () => {
        throw new NonRetryableError("not found");
      });
      const id = queue.enqueue({ runId: "a", type: "release_detail", payload: { releaseId: 1 } });

      queue.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(status(id).status).toBe("failed");
      expect(queue.getPause()).toBeNull();
    });

    it("gives up after MAX_CAP_RETRIES retries at the 10 min cap, failing every run's pending jobs", async () => {
      const handler = vi.fn(async () => {
        throw new DiscogsTransientError("down");
      });
      queue.registerHandler("fade_lookup", handler);
      const aborted = vi.fn();
      queue.onRunAborted(aborted);
      const first = queue.enqueue({ runId: "a", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 1 } });
      const sameRun = queue.enqueue({ runId: "a", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 2 } });
      const otherRun = queue.enqueue({ runId: "b", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 3 } });

      queue.start();
      await vi.advanceTimersByTimeAsync(0);
      // failures 1-4 ramp up, then each of the next MAX_CAP_RETRIES failures is a retry at the cap
      for (let i = 0; i < 4 + MAX_CAP_RETRIES; i++) {
        await vi.advanceTimersByTimeAsync(queue.getPause()!.backoffMs);
      }

      expect(handler).toHaveBeenCalledTimes(5 + MAX_CAP_RETRIES);
      expect(status(first).status).toBe("failed");
      expect(status(sameRun).status).toBe("failed");
      expect(status(otherRun).status).toBe("failed");
      expect(aborted).toHaveBeenCalledWith("a");
      expect(aborted).toHaveBeenCalledWith("b");
      expect(queue.getPause()).toBeNull();
    });

    it("skips an enrich job after MAX_TRANSIENT_ATTEMPTS Discogs errors and carries on with the next", async () => {
      const handler = vi.fn(async (payload: { releaseId: number }) => {
        if (payload.releaseId === 1) throw new DiscogsTransientError("500");
      });
      queue.registerHandler("release_detail", handler);
      const settled = vi.fn();
      queue.onSettled(settled);
      const bad = queue.enqueue({ runId: "a", type: "release_detail", payload: { releaseId: 1 } });
      const good = queue.enqueue({ runId: "a", type: "release_detail", payload: { releaseId: 2 } });

      queue.start();
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 1; i < MAX_TRANSIENT_ATTEMPTS; i++) {
        expect(status(bad).status).toBe("pending");
        await vi.advanceTimersByTimeAsync(queue.getPause()!.backoffMs);
      }

      expect(status(bad)).toMatchObject({ status: "failed", attempts: 0 });
      expect(status(bad).errorMessage).toContain("Skipped after");
      expect(status(good).status).toBe("pending");
      expect(settled).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(queue.getPause()!.backoffMs);
      expect(status(good).status).toBe("done");
    });

    it("does not skip a scan page on repeated Discogs errors", async () => {
      queue.registerHandler("fade_lookup", vi.fn(async () => {
        throw new DiscogsTransientError("500");
      }));
      const id = queue.enqueue({ runId: "a", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 1 } });

      queue.start();
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < MAX_TRANSIENT_ATTEMPTS + 1; i++) {
        await vi.advanceTimersByTimeAsync(queue.getPause()!.backoffMs);
      }

      expect(status(id).status).toBe("pending");
    });

    it("still gives up when every enrich job keeps failing, skipping only the first few", async () => {
      queue.registerHandler("release_detail", async () => {
        throw new DiscogsTransientError("down");
      });
      const aborted = vi.fn();
      queue.onRunAborted(aborted);
      const ids = [1, 2, 3, 4].map((releaseId) =>
        queue.enqueue({ runId: "a", type: "release_detail", payload: { releaseId } }),
      );

      queue.start();
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 4 + MAX_CAP_RETRIES; i++) {
        await vi.advanceTimersByTimeAsync(queue.getPause()!.backoffMs);
      }

      expect(aborted).toHaveBeenCalledWith("a");
      expect(ids.map((id) => status(id).status)).toEqual(["failed", "failed", "failed", "failed"]);
      expect(queue.getPause()).toBeNull();
    });

    it("fails the run on a 401/403 without pausing the queue or touching other runs", async () => {
      const handler = vi.fn(async (_payload: { releaseId: number }, ctx: { runId: string }) => {
        if (ctx.runId === "a") throw new DiscogsAuthError("bad token");
      });
      queue.registerHandler("release_detail", handler);
      const aborted = vi.fn();
      queue.onRunAborted(aborted);
      const first = queue.enqueue({ runId: "a", type: "release_detail", payload: { releaseId: 1 } });
      const sameRun = queue.enqueue({ runId: "a", type: "release_detail", payload: { releaseId: 2 } });
      const otherRun = queue.enqueue({ runId: "b", type: "release_detail", payload: { releaseId: 3 } });

      queue.start();
      await vi.advanceTimersByTimeAsync(PACING_MS);

      expect(status(first).status).toBe("failed");
      expect(status(sameRun).status).toBe("failed");
      expect(status(otherRun).status).toBe("done");
      expect(aborted).toHaveBeenCalledWith("a");
      expect(aborted).not.toHaveBeenCalledWith("b");
      expect(queue.getPause()).toBeNull();
    });

    it("rejects an inline request fast while paused, and one already waiting when the pause starts", async () => {
      queue.registerHandler("release_detail", flaky(1, new DiscogsTransientError("boom")));
      const waiting = queue.enqueueAndWait({
        runId: "inline-1",
        type: "release_detail",
        payload: { releaseId: 1 },
      });
      const outcome = waiting.catch((err: unknown) => err);

      queue.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(await outcome).toBeInstanceOf(QueueUnavailableError);
      await expect(
        queue.enqueueAndWait({ runId: "inline-2", type: "release_detail", payload: { releaseId: 2 } }),
      ).rejects.toBeInstanceOf(QueueUnavailableError);
    });
  });
});
