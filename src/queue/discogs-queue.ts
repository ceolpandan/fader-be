import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { discogsQueueJobs, type QueueJobPayloadMap, type QueueJobType } from "../db/schema";
import { DiscogsAuthError, DiscogsTransientError } from "../discogs-client";
import { logger, highlightId } from "../util/logger";

export const PACING_MS = 1100;
export const MAX_ATTEMPTS = 3;
/** Priority for work a user is actively waiting on (vs. 0 for background indexing). */
export const INLINE_PRIORITY = 10;
export const DEFAULT_WAIT_TIMEOUT_MS = 20_000;
export const BASE_BACKOFF_MS = 2000;
/** The first pause after a transient Discogs error; each further failure in a row doubles it. */
export const PAUSE_BASE_MS = 60_000;
export const PAUSE_CAP_MS = 10 * 60_000;
/** Retries at the cap (with no success in between) before the queue gives up on Discogs. */
export const MAX_CAP_RETRIES = 5;
/**
 * Transient Discogs errors one enrich job may hit before it is skipped. The queue still pauses
 * after each, so a real outage keeps counting towards MAX_CAP_RETRIES and aborts the runs.
 */
export const MAX_TRANSIENT_ATTEMPTS = 3;

export class NonRetryableError extends Error {}

/** `enqueueAndWait` gave up waiting; the job itself is still queued and will run. */
export class QueueWaitTimeoutError extends Error {}

/** Discogs is paused and retrying; an inline request fails fast instead of waiting it out. */
export class QueueUnavailableError extends Error {}

export interface JobHandlerContext {
  runId: string;
  jobId: number;
  /** 1 on the first try; the job fails for good once this reaches MAX_ATTEMPTS. */
  attempt?: number;
}

export type JobHandler<TPayload = unknown> = (
  payload: TPayload,
  context: JobHandlerContext,
) => Promise<void>;

type QueueJobRow = typeof discogsQueueJobs.$inferSelect;

export interface EnqueueInput {
  runId: string;
  type: QueueJobType;
  payload: unknown;
  /** Higher runs first; ties run in enqueue (id) order. Defaults to 0. */
  priority?: number;
}

export type SettledListener = (job: QueueJobRow) => void;

export interface QueuePause {
  retryAt: Date;
  /** How long this pause lasts in total: the backoff step, or Retry-After when longer. */
  backoffMs: number;
}

export class DiscogsQueue {
  private readonly handlers = new Map<QueueJobType, JobHandler>();
  private readonly backoffUntil = new Map<number, number>();
  /** Transient Discogs errors per enrich job. Memory only, so a restart gives a job fresh strikes. */
  private readonly transientFailures = new Map<number, number>();
  private readonly settledListeners: SettledListener[] = [];
  private readonly waiters = new Map<
    number,
    { resolve: () => void; reject: (cause: unknown) => void }
  >();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly abortedListeners: ((runId: string) => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Set after a transient Discogs error: no job runs before `retryAt`, for any run. Cleared once
   * Discogs answers again. Kept in memory only; a restart simply starts over at PAUSE_BASE_MS.
   */
  private pause: { retryAt: number; backoffMs: number } | null = null;
  private consecutiveFailures = 0;
  private capRetries = 0;

  constructor(private readonly db: Db) {}

  registerHandler<T extends QueueJobType>(type: T, handler: JobHandler<QueueJobPayloadMap[T]>): void {
    this.handlers.set(type, handler as JobHandler);
  }

  /** Notified once a job reaches a terminal state (done or failed) — never on a retry. */
  onSettled(listener: SettledListener): void {
    this.settledListeners.push(listener);
  }

  /** Notified once for each run cut short (Discogs gave up, or refused our token), after its jobs are failed. */
  onRunAborted(listener: (runId: string) => void): void {
    this.abortedListeners.push(listener);
  }

  /** The current pause, until the retry that ends it succeeds; null while Discogs is answering. */
  getPause(): QueuePause | null {
    return this.pause
      ? { retryAt: new Date(this.pause.retryAt), backoffMs: this.pause.backoffMs }
      : null;
  }

  enqueue(job: EnqueueInput): number {
    const now = new Date();
    const [inserted] = this.db
      .insert(discogsQueueJobs)
      .values({
        runId: job.runId,
        type: job.type,
        payload: job.payload as never,
        priority: job.priority ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all();

    return inserted!.id;
  }

  /**
   * Enqueue at high priority and wait for the job to reach a terminal state. Resolves on
   * success; the caller re-reads whatever the handler persisted. Concurrent calls for the
   * same type + payload share one job, and each caller has its own wait timeout.
   */
  enqueueAndWait(
    job: EnqueueInput,
    { timeoutMs = DEFAULT_WAIT_TIMEOUT_MS }: { timeoutMs?: number } = {},
  ): Promise<void> {
    if (this.pause && Date.now() < this.pause.retryAt) {
      return Promise.reject(new QueueUnavailableError("Discogs unavailable, retrying"));
    }
    const key = `${job.type}:${JSON.stringify(job.payload)}`;
    let settled = this.inFlight.get(key);
    if (!settled) {
      const jobId = this.enqueue({ ...job, priority: job.priority ?? INLINE_PRIORITY });
      settled = new Promise<void>((resolve, reject) => {
        this.waiters.set(jobId, { resolve, reject });
      });
      const forget = () => this.inFlight.delete(key);
      settled.then(forget, forget);
      this.inFlight.set(key, settled);
    }

    const shared = settled;
    return new Promise<void>((resolve, reject) => {
      // Timing out only stops this caller waiting — the job stays queued and still persists.
      const timer = setTimeout(() => {
        reject(new QueueWaitTimeoutError(`Timed out after ${timeoutMs}ms waiting for ${key}`));
      }, timeoutMs);
      shared.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (cause: unknown) => {
          clearTimeout(timer);
          reject(cause);
        },
      );
    });
  }

  recoverStuckJobs(): void {
    this.db
      .update(discogsQueueJobs)
      .set({ status: "pending", updatedAt: new Date() })
      .where(eq(discogsQueueJobs.status, "processing"))
      .run();
  }

  start(): void {
    this.recoverStuckJobs();
    this.scheduleNextTick(0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNextTick(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    const job = this.claimNextJob();
    if (job) {
      await this.processJob(job);
    }
    const pausedFor = this.pause ? this.pause.retryAt - Date.now() : 0;
    this.scheduleNextTick(Math.max(PACING_MS, pausedFor));
  }

  private claimNextJob(): QueueJobRow | null {
    const now = Date.now();
    const pending = this.db
      .select()
      .from(discogsQueueJobs)
      .where(eq(discogsQueueJobs.status, "pending"))
      .orderBy(desc(discogsQueueJobs.priority), asc(discogsQueueJobs.id))
      .all();

    const ready = pending.filter((job) => (this.backoffUntil.get(job.id) ?? 0) <= now);
    const eligible = ready[0];
    if (!eligible) return null;

    this.db
      .update(discogsQueueJobs)
      .set({ status: "processing", updatedAt: new Date() })
      .where(eq(discogsQueueJobs.id, eligible.id))
      .run();

    return eligible;
  }

  private async processJob(job: QueueJobRow): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.markFailed(job, `No handler registered for job type "${job.type}"`);
      return;
    }

    logger.info(`Processing job ${highlightId(job.id)} (${job.type}, run ${job.runId})`);

    try {
      await handler(job.payload, { runId: job.runId, jobId: job.id, attempt: job.attempts + 1 });
      this.markDone(job);
    } catch (err) {
      this.handleFailure(job, err);
    }
  }

  private markDone(job: QueueJobRow): void {
    const updatedAt = new Date();
    this.db
      .update(discogsQueueJobs)
      .set({ status: "done", updatedAt })
      .where(eq(discogsQueueJobs.id, job.id))
      .run();
    this.backoffUntil.delete(job.id);
    this.transientFailures.delete(job.id);
    this.resetPause();
    logger.info(`Job ${highlightId(job.id)} done`);
    this.notifySettled({ ...job, status: "done", updatedAt });
  }

  private markFailed(
    job: QueueJobRow,
    errorMessage: string,
    attempts = job.attempts,
    cause: unknown = new Error(errorMessage),
  ): void {
    const updatedAt = new Date();
    this.db
      .update(discogsQueueJobs)
      .set({ status: "failed", attempts, errorMessage, updatedAt })
      .where(eq(discogsQueueJobs.id, job.id))
      .run();
    this.backoffUntil.delete(job.id);
    this.transientFailures.delete(job.id);
    logger.error(`Job ${highlightId(job.id)} failed permanently: ${errorMessage}`);
    this.notifySettled({ ...job, status: "failed", attempts, errorMessage, updatedAt }, cause);
  }

  private notifySettled(job: QueueJobRow, cause?: unknown): void {
    const waiter = this.waiters.get(job.id);
    this.waiters.delete(job.id);
    if (job.status === "failed") waiter?.reject(cause);
    else waiter?.resolve();
    for (const listener of this.settledListeners) listener(job);
  }

  private resetPause(): void {
    this.pause = null;
    this.consecutiveFailures = 0;
    this.capRetries = 0;
  }

  /**
   * Discogs is erroring: keep every run off Discogs for the next backoff step and release inline
   * callers instead of making them wait. An enrich job goes back untouched (a pause costs no
   * attempts) until it has hit MAX_TRANSIENT_ATTEMPTS errors; then it is skipped, so one release
   * Discogs cannot serve does not hold up the rest. The pause and the failure counters carry on
   * either way, so a real outage still ends in `giveUp`.
   */
  private pauseAndRetry(job: QueueJobRow, err: DiscogsTransientError): void {
    this.consecutiveFailures += 1;
    const stepMs = Math.min(PAUSE_BASE_MS * 2 ** (this.consecutiveFailures - 1), PAUSE_CAP_MS);
    if (stepMs === PAUSE_CAP_MS) this.capRetries += 1;

    if (this.capRetries > MAX_CAP_RETRIES) {
      this.giveUp(job, err);
      return;
    }

    const backoffMs = Math.max(stepMs, err.retryAfterMs ?? 0);
    this.pause = { retryAt: Date.now() + backoffMs, backoffMs };

    const failures = (this.transientFailures.get(job.id) ?? 0) + 1;
    if (job.type === "release_detail" && failures >= MAX_TRANSIENT_ATTEMPTS) {
      // Fail it before releasing the other waiters, so its own caller gets the real error.
      this.markFailed(job, `Skipped after ${failures} Discogs errors: ${err.message}`, job.attempts, err);
    } else {
      this.transientFailures.set(job.id, failures);
      this.db
        .update(discogsQueueJobs)
        .set({ status: "pending", errorMessage: err.message, updatedAt: new Date() })
        .where(eq(discogsQueueJobs.id, job.id))
        .run();
    }

    logger.warn(
      `Discogs is erroring, pausing the queue for ${backoffMs}ms (failure ${this.consecutiveFailures} in a row): ${err.message}`,
    );

    const unavailable = new QueueUnavailableError("Discogs unavailable, retrying");
    for (const waiter of this.waiters.values()) waiter.reject(unavailable);
    this.waiters.clear();
  }

  /** Discogs stayed down through every retry: fail all unfinished work, so each run ends in error. */
  private giveUp(job: QueueJobRow, err: DiscogsTransientError): void {
    logger.error(`Discogs still erroring after ${MAX_CAP_RETRIES} retries at the cap, giving up: ${err.message}`);
    this.resetPause();
    this.abortRuns(job, `Gave up on Discogs: ${err.message}`, err, "all");
  }

  /**
   * Fail `job` and every pending job of the affected runs (all runs, or just the job's), then tell
   * the listeners. Listeners run last, once the jobs are marked failed.
   */
  private abortRuns(job: QueueJobRow, errorMessage: string, cause: unknown, scope: "all" | "run"): void {
    const pendingInScope = and(
      eq(discogsQueueJobs.status, "pending"),
      scope === "run" ? eq(discogsQueueJobs.runId, job.runId) : undefined,
    );
    const runIds = new Set([
      job.runId,
      ...this.db
        .select({ runId: discogsQueueJobs.runId })
        .from(discogsQueueJobs)
        .where(pendingInScope)
        .all()
        .map((row) => row.runId),
    ]);

    const pendingIds = this.db
      .select({ id: discogsQueueJobs.id })
      .from(discogsQueueJobs)
      .where(pendingInScope)
      .all()
      .map((row) => row.id);

    this.db
      .update(discogsQueueJobs)
      .set({ status: "failed", errorMessage, updatedAt: new Date() })
      .where(and(eq(discogsQueueJobs.status, "pending"), inArray(discogsQueueJobs.runId, [...runIds])))
      .run();

    for (const id of pendingIds) {
      this.transientFailures.delete(id);
      this.waiters.get(id)?.reject(cause);
      this.waiters.delete(id);
    }

    this.markFailed(job, errorMessage, job.attempts, cause);
    for (const runId of runIds) {
      for (const listener of this.abortedListeners) listener(runId);
    }
  }

  private handleFailure(job: QueueJobRow, err: unknown): void {
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (err instanceof DiscogsTransientError) {
      this.pauseAndRetry(job, err);
      return;
    }
    // Discogs answered, so the outage (if any) is over, even if this job still failed.
    this.resetPause();

    if (err instanceof DiscogsAuthError) {
      logger.error(`Run ${job.runId} aborted: ${errorMessage}`);
      this.abortRuns(job, errorMessage, err, "run");
      return;
    }

    const attempts = job.attempts + 1;

    if (err instanceof NonRetryableError || attempts >= MAX_ATTEMPTS) {
      this.markFailed(job, errorMessage, attempts, err);
      return;
    }

    const backoffMs = BASE_BACKOFF_MS * 2 ** (attempts - 1);
    this.backoffUntil.set(job.id, Date.now() + backoffMs);

    this.db
      .update(discogsQueueJobs)
      .set({ status: "pending", attempts, errorMessage, updatedAt: new Date() })
      .where(eq(discogsQueueJobs.id, job.id))
      .run();

    logger.warn(
      `Job ${highlightId(job.id)} failed (attempt ${attempts}/${MAX_ATTEMPTS}), retrying in ${backoffMs}ms: ${errorMessage}`,
    );
  }
}
