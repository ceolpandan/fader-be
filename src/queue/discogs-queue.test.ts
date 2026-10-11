import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createDb, type Db } from "../db/client";
import { discogsQueueJobs } from "../db/schema";
import { DiscogsAuthError, DiscogsRateLimitError, DiscogsServerError, DiscogsTransientError } from "../discogs-client";
import {
  DEAD_LETTER_OUTAGE_THRESHOLD,
  DiscogsQueue,
  MAX_CAP_RETRIES,
  NonRetryableError,
  QueueUnavailableError,
  PACING_MS,
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
    queue.registerHandler("fade_lookup", handler);

    const jobId = queue.enqueue({
      runId: "run-1",
      type: "fade_lookup",
      payload: { uid: "u", kind: "release", id: 732194 },
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
        order.push(`job-${payload.id}`);
      }),
    );

    queue.enqueue({ runId: "run-1", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 1 } });
    queue.enqueue({ runId: "run-1", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 2 } });
    queue.enqueue({ runId: "run-2", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 7 }, priority: 10 });

    queue.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PACING_MS * 2);

    expect(order).toEqual(["job-7", "job-1", "job-2"]);
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

    queue.registerHandler(
      "fade_lookup",
      vi.fn(async (payload: { id: number }) => {
        if (payload.id === 2) throw new NonRetryableError("nope");
      }),
    );

    queue.enqueue({ runId: "run-1", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 1 } });
    queue.enqueue({ runId: "run-1", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 2 } });

    queue.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PACING_MS);

    expect(settled).toEqual(["fade_lookup:done", "fade_lookup:failed"]);
  });

  it("lets a priority job cut in mid-run, then resumes background jobs in order", async () => {
    const order: string[] = [];
    queue.registerHandler(
      "fade_lookup",
      vi.fn(async (payload: { id: number }) => {
        order.push(`job-${payload.id}`);
      }),
    );
    for (const page of [1, 2, 3]) {
      queue.enqueue({ runId: "run-1", type: "fade_lookup", payload: { uid: "u", kind: "release", id: page } });
    }

    queue.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["job-1"]);

    const inline = queue.enqueueAndWait({
      runId: "inline",
      type: "fade_lookup",
      payload: { uid: "u", kind: "release", id: 7 },
    });
    await vi.advanceTimersByTimeAsync(PACING_MS * 3);
    await inline;

    expect(order).toEqual(["job-1", "job-7", "job-2", "job-3"]);
  });

  describe("enqueueAndWait", () => {
    it("resolves once the handler succeeds, jumping ahead of pending background jobs", async () => {
      const order: string[] = [];
      queue.registerHandler(
        "fade_lookup",
        vi.fn(async (payload: { id: number }) => {
          order.push(`job-${payload.id}`);
        }),
      );
      queue.enqueue({ runId: "run-1", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 1 } });

      const waiting = queue.enqueueAndWait({
        runId: "inline-1",
        type: "fade_lookup",
        payload: { uid: "u", kind: "release", id: 7 },
      });
      queue.start();
      await vi.advanceTimersByTimeAsync(0);

      await expect(waiting).resolves.toBeUndefined();
      expect(order).toEqual(["job-7"]);
    });

    it("rejects with the original NonRetryableError on a permanent failure", async () => {
      const failure = new NonRetryableError("release not found");
      queue.registerHandler(
        "fade_lookup",
        vi.fn(async () => {
          throw failure;
        }),
      );

      const waiting = queue.enqueueAndWait({
        runId: "inline-1",
        type: "fade_lookup",
        payload: { uid: "u", kind: "release", id: 7 },
      });
      const outcome = waiting.catch((err: unknown) => err);
      queue.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(await outcome).toBe(failure);
    });

    it("rejects with QueueWaitTimeoutError after timeoutMs, while the job still runs and completes later", async () => {
      const handler = vi.fn(async () => {});
      queue.registerHandler("fade_lookup", handler);

      const waiting = queue.enqueueAndWait(
        { runId: "inline-1", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 7 } },
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
      queue.registerHandler("fade_lookup", handler);
      const request = () =>
        queue.enqueueAndWait({
          runId: "inline",
          type: "fade_lookup",
          payload: { uid: "u", kind: "release", id: 7 },
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
        "fade_lookup",
        vi.fn(async () => {
          throw failure;
        }),
      );
      const request = () =>
        queue
          .enqueueAndWait({ runId: "inline", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 7 } })
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
      queue.registerHandler("fade_lookup", handler);

      const waiting = queue.enqueueAndWait({
        runId: "inline-1",
        type: "fade_lookup",
        payload: { uid: "u", kind: "release", id: 7 },
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
      queue.registerHandler("fade_lookup", handler);
      const id = queue.enqueue({ runId: "a", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 1 } });

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
      queue.registerHandler("fade_lookup", handler);
      queue.enqueue({ runId: "a", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 1 } });
      queue.enqueue({ runId: "b", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 2 } });

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
        const pause = queue.getPause("u")!;
        waits.push(Math.round((pause.retryAt.getTime() - Date.now()) / MIN));
        await vi.advanceTimersByTimeAsync(pause.backoffMs);
      }
      expect(waits).toEqual([1, 2, 4, 8, 10]);
      expect(handler).toHaveBeenCalledTimes(6);
      expect(queue.getPause("u")).toBeNull();

      // the next failure starts over at 1 min
      queue.registerHandler("fade_lookup", flaky(1, new DiscogsTransientError("again")));
      queue.enqueue({ runId: "a", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 2 } });
      await vi.advanceTimersByTimeAsync(PACING_MS);
      expect(queue.getPause("u")!.backoffMs).toBe(MIN);
    });

    it("waits for Retry-After when it is longer than the backoff step", async () => {
      queue.registerHandler("fade_lookup", flaky(1, new DiscogsRateLimitError("slow down", 5 * MIN)));
      queue.enqueue({ runId: "a", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 1 } });

      queue.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(queue.getPause("u")!.backoffMs).toBe(5 * MIN);
    });

    it("ignores a Retry-After shorter than the backoff step", async () => {
      queue.registerHandler("fade_lookup", flaky(1, new DiscogsRateLimitError("slow down", 5_000)));
      queue.enqueue({ runId: "a", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 1 } });

      queue.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(queue.getPause("u")!.backoffMs).toBe(MIN);
    });

    it("keeps failing a 404 permanently and does not pause", async () => {
      queue.registerHandler("fade_lookup", async () => {
        throw new NonRetryableError("not found");
      });
      const id = queue.enqueue({ runId: "a", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 1 } });

      queue.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(status(id).status).toBe("failed");
      expect(queue.getPause("u")).toBeNull();
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
        await vi.advanceTimersByTimeAsync(queue.getPause("u")!.backoffMs);
      }

      expect(handler).toHaveBeenCalledTimes(5 + MAX_CAP_RETRIES);
      expect(status(first).status).toBe("failed");
      expect(status(sameRun).status).toBe("failed");
      expect(status(otherRun).status).toBe("failed");
      expect(aborted).toHaveBeenCalledWith("a", expect.any(Error));
      expect(aborted).toHaveBeenCalledWith("b", expect.any(Error));
      expect(queue.getPause("u")).toBeNull();
    });

    it("keeps retrying one job through repeated Discogs errors", async () => {
      queue.registerHandler("fade_lookup", vi.fn(async () => {
        throw new DiscogsTransientError("500");
      }));
      const id = queue.enqueue({ runId: "a", type: "fade_lookup", payload: { uid: "u", kind: "release", id: 1 } });

      queue.start();
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(queue.getPause("u")!.backoffMs);
      }

      expect(status(id).status).toBe("pending");
    });


  describe("Discogs server errors (5xx)", () => {
    const status = (id: number) =>
      db.select().from(discogsQueueJobs).where(eq(discogsQueueJobs.id, id)).all()[0]!;
    const enqueue = (releaseId: number) =>
      queue.enqueue({ runId: "r", type: "release_detail", payload: { uid: "u", releaseId } });

    it("retries a job at the lane's pace without pausing, and sets it aside after 3 tries", async () => {
      const calls: number[] = [];
      queue.registerHandler("release_detail", async ({ releaseId }) => {
        calls.push(releaseId);
        if (releaseId === 1) throw new DiscogsServerError("Discogs API error 500 for /releases/1");
      });
      const bad = enqueue(1);
      const good = enqueue(2);

      queue.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual([1]);
      expect(queue.getPause("u")).toBeNull();
      expect(status(bad).status).toBe("pending");

      await vi.advanceTimersByTimeAsync(PACING_MS);
      await vi.advanceTimersByTimeAsync(PACING_MS);
      expect(calls).toEqual([1, 1, 1]);
      expect(status(bad)).toMatchObject({ status: "failed", attempts: 3 });
      expect(status(bad).errorMessage).toContain("500");

      await vi.advanceTimersByTimeAsync(PACING_MS);
      expect(calls).toEqual([1, 1, 1, 2]);
      expect(status(good).status).toBe("done");
      expect(queue.getPause("u")).toBeNull();
    });

    it("treats a run of set-aside jobs as an outage: it takes them back and pauses the lane", async () => {
      queue.registerHandler("release_detail", async () => {
        throw new DiscogsServerError("Discogs API error 500");
      });
      const ids = Array.from({ length: DEAD_LETTER_OUTAGE_THRESHOLD + 1 }, (_, i) => enqueue(i + 1));

      queue.start();
      await vi.advanceTimersByTimeAsync(PACING_MS * (DEAD_LETTER_OUTAGE_THRESHOLD * 3));

      expect(queue.getPause("u")).not.toBeNull();
      expect(ids.map((id) => status(id).status)).toEqual(ids.map(() => "pending"));
    });

    it("forgets earlier set-aside jobs once a job succeeds", async () => {
      queue.registerHandler("release_detail", async ({ releaseId }) => {
        if (releaseId % 2 === 1) throw new DiscogsServerError("500");
      });
      for (let i = 1; i <= DEAD_LETTER_OUTAGE_THRESHOLD * 2; i++) enqueue(i);

      queue.start();
      await vi.advanceTimersByTimeAsync(PACING_MS * 60);

      expect(queue.getPause("u")).toBeNull();
      expect(db.select().from(discogsQueueJobs).where(eq(discogsQueueJobs.status, "failed")).all()).toHaveLength(
        DEAD_LETTER_OUTAGE_THRESHOLD,
      );
    });
  });

  });
});

describe("DiscogsQueue lanes", () => {
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

  const job = (uid: string, id: number, runId = `run-${uid}`) =>
    queue.enqueue({ runId, type: "fade_lookup", payload: { uid, kind: "release", id } });
  const statusOf = (jobId: number) =>
    db.select().from(discogsQueueJobs).where(eq(discogsQueueJobs.id, jobId)).get()!.status;

  it("records the collector a job belongs to", () => {
    const jobId = job("alice", 1);

    expect(db.select().from(discogsQueueJobs).where(eq(discogsQueueJobs.id, jobId)).get()!.uid).toBe("alice");
  });

  it("runs each collector's jobs on their own lane, one per pacing step", async () => {
    const handler = vi.fn(async () => {});
    queue.registerHandler("fade_lookup", handler);
    job("alice", 1);
    const alice2 = job("alice", 2);
    job("bob", 3);

    queue.start();
    await vi.advanceTimersByTimeAsync(0);

    // alice's first and bob's first run together; alice's second waits for her pacing.
    expect(handler).toHaveBeenCalledTimes(2);
    expect(statusOf(alice2)).toBe("pending");

    await vi.advanceTimersByTimeAsync(PACING_MS);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(statusOf(alice2)).toBe("done");
  });

  it("keeps a collector's jobs PACING_MS apart even when a job arrives right after one finished", async () => {
    const starts: number[] = [];
    queue.registerHandler("fade_lookup", async () => {
      starts.push(Date.now());
    });
    queue.start();
    job("alice", 1);
    await vi.advanceTimersByTimeAsync(0);
    job("alice", 2);
    await vi.advanceTimersByTimeAsync(PACING_MS);

    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(PACING_MS);
  });

  it("pauses only the lane whose token Discogs is erroring on", async () => {
    const handled: string[] = [];
    queue.registerHandler("fade_lookup", async (payload) => {
      handled.push(payload.uid);
      if (payload.uid === "alice") throw new DiscogsTransientError("boom");
    });
    job("alice", 1);
    queue.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(queue.getPause("alice")).not.toBeNull();
    expect(queue.getPause("bob")).toBeNull();

    const bob = job("bob", 2);
    await vi.advanceTimersByTimeAsync(PACING_MS);

    expect(statusOf(bob)).toBe("done");
    expect(handled.filter((uid) => uid === "alice")).toHaveLength(1);
  });

  it("refuses an inline request only on the paused lane", async () => {
    queue.registerHandler("fade_lookup", async () => {
      throw new DiscogsTransientError("boom");
    });
    job("alice", 1);
    queue.start();
    await vi.advanceTimersByTimeAsync(0);

    await expect(
      queue.enqueueAndWait({ runId: "inline", type: "fade_lookup", payload: { uid: "alice", kind: "release", id: 9 } }),
    ).rejects.toThrow(QueueUnavailableError);

    queue.registerHandler("fade_lookup", async () => {});
    const waiting = queue.enqueueAndWait({
      runId: "inline",
      type: "fade_lookup",
      payload: { uid: "bob", kind: "release", id: 9 },
    });
    await vi.advanceTimersByTimeAsync(0);
    await expect(waiting).resolves.toBeUndefined();
  });

  it("stops only the rejected collector's run when Discogs refuses their token", async () => {
    queue.registerHandler("fade_lookup", async (payload) => {
      if (payload.uid === "alice") throw new DiscogsAuthError("token rejected");
    });
    const aliceFirst = job("alice", 1, "alice-run");
    const aliceSecond = job("alice", 2, "alice-run");
    const bob = job("bob", 3);

    queue.start();
    await vi.advanceTimersByTimeAsync(PACING_MS * 2);

    expect(statusOf(aliceFirst)).toBe("failed");
    expect(statusOf(aliceSecond)).toBe("failed");
    expect(statusOf(bob)).toBe("done");
  });

  it("gives up on one collector's work without failing everyone else's", async () => {
    queue.registerHandler("fade_lookup", async (payload) => {
      if (payload.uid === "alice") throw new DiscogsTransientError("down");
    });
    const alice = job("alice", 1);
    queue.start();
    for (let i = 0; i < 20 && statusOf(alice) !== "failed"; i++) {
      await vi.advanceTimersByTimeAsync(11 * 60_000);
    }
    expect(statusOf(alice)).toBe("failed");

    const bob = job("bob", 2);
    await vi.advanceTimersByTimeAsync(PACING_MS);

    expect(statusOf(bob)).toBe("done");
  });
});
