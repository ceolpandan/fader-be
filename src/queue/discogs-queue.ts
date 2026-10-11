import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { discogsQueueJobs, type QueueJobPayloadMap, type QueueJobType } from "../db/schema";
import { DiscogsAuthError, DiscogsServerError, DiscogsTransientError } from "../discogs-client";
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
 * Jobs set aside in a row after Discogs answered 5xx on all their tries, with no success between.
 * That many is an outage rather than bad releases, so the lane pauses and takes them back.
 */
export const DEAD_LETTER_OUTAGE_THRESHOLD = 5;
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

/**
 * One lane per collector (per Discogs token): Discogs rate-limits each token on its own, so a
 * lane paces its jobs at PACING_MS and pauses on its own, without holding up the others.
 * Everything here is memory only; a restart starts every lane over.
 */
interface Lane {
  timer: ReturnType<typeof setTimeout> | null;
  /** A job is being processed, so the tick that runs it schedules the next one. */
  running: boolean;
  /** No job starts before this, which keeps jobs PACING_MS apart. */
  nextAllowedAt: number;
  /**
   * Set after a transient Discogs error: no job of the lane runs before `retryAt`. Cleared once
   * Discogs answers again.
   */
  pause: { retryAt: number; backoffMs: number } | null;
  consecutiveFailures: number;
  capRetries: number;
  /** Jobs set aside after exhausting their tries on a 5xx, since the last success. */
  deadLettered: number[];
}

export class DiscogsQueue {
  private readonly handlers = new Map<QueueJobType, JobHandler>();
  private readonly backoffUntil = new Map<number, number>();
  private readonly settledListeners: SettledListener[] = [];
  private readonly waiters = new Map<
    number,
    { uid: string; resolve: () => void; reject: (cause: unknown) => void }
  >();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly abortedListeners: ((runId: string, cause: unknown) => void)[] = [];
  private readonly lanes = new Map<string, Lane>();
  private started = false;

  constructor(private readonly db: Db) {}

  registerHandler<T extends QueueJobType>(type: T, handler: JobHandler<QueueJobPayloadMap[T]>): void {
    this.handlers.set(type, handler as JobHandler);
  }

  /** Notified once a job reaches a terminal state (done or failed) — never on a retry. */
  onSettled(listener: SettledListener): void {
    this.settledListeners.push(listener);
  }

  /** Notified once for each run cut short (Discogs gave up, or refused our token), after its jobs are failed. */
  onRunAborted(listener: (runId: string, cause: unknown) => void): void {
    this.abortedListeners.push(listener);
  }

  private lane(uid: string): Lane {
    let lane = this.lanes.get(uid);
    if (!lane) {
      lane = { timer: null, running: false, nextAllowedAt: 0, pause: null, consecutiveFailures: 0, capRetries: 0, deadLettered: [] };
      this.lanes.set(uid, lane);
    }
    return lane;
  }

  /** The collector's current pause, until the retry that ends it succeeds; null while Discogs is answering. */
  getPause(uid: string): QueuePause | null {
    const pause = this.lanes.get(uid)?.pause;
    return pause ? { retryAt: new Date(pause.retryAt), backoffMs: pause.backoffMs } : null;
  }

  /** Queues a job on the lane of the collector whose token it uses (`payload.uid`). */
  enqueue(job: EnqueueInput): number {
    const now = new Date();
    const uid = (job.payload as { uid: string }).uid;
    const [inserted] = this.db
      .insert(discogsQueueJobs)
      .values({
        uid,
        runId: job.runId,
        type: job.type,
        payload: job.payload as never,
        priority: job.priority ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all();

    this.wake(uid);
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
    const uid = (job.payload as { uid: string }).uid;
    const pause = this.lanes.get(uid)?.pause;
    if (pause && Date.now() < pause.retryAt) {
      return Promise.reject(new QueueUnavailableError("Discogs unavailable, retrying"));
    }
    const key = `${job.type}:${JSON.stringify(job.payload)}`;
    let settled = this.inFlight.get(key);
    if (!settled) {
      const jobId = this.enqueue({ ...job, priority: job.priority ?? INLINE_PRIORITY });
      settled = new Promise<void>((resolve, reject) => {
        this.waiters.set(jobId, { uid, resolve, reject });
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

  /** Drops the run's jobs that have not started; returns how many. The one being processed finishes. */
  cancelRun(runId: string): number {
    const pending = and(eq(discogsQueueJobs.runId, runId), eq(discogsQueueJobs.status, "pending"));
    const ids = this.db.select({ id: discogsQueueJobs.id }).from(discogsQueueJobs).where(pending).all();
    this.db.delete(discogsQueueJobs).where(pending).run();
    for (const { id } of ids) {
      this.backoffUntil.delete(id);
      this.waiters.get(id)?.reject(new Error("Run cancelled"));
      this.waiters.delete(id);
    }
    return ids.length;
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
    this.started = true;
    const uids = this.db
      .selectDistinct({ uid: discogsQueueJobs.uid })
      .from(discogsQueueJobs)
      .where(eq(discogsQueueJobs.status, "pending"))
      .all();
    for (const { uid } of uids) this.wake(uid);
  }

  stop(): void {
    this.started = false;
    for (const lane of this.lanes.values()) {
      if (lane.timer) clearTimeout(lane.timer);
      lane.timer = null;
    }
  }

  /** Makes sure the lane has a tick coming, no sooner than its pacing and pause allow. */
  private wake(uid: string): void {
    if (!this.started) return;
    const lane = this.lane(uid);
    if (lane.timer || lane.running) return;
    this.scheduleTick(uid, lane, 0);
  }

  private scheduleTick(uid: string, lane: Lane, minDelayMs: number): void {
    const now = Date.now();
    const delayMs = Math.max(minDelayMs, lane.nextAllowedAt - now, lane.pause ? lane.pause.retryAt - now : 0);
    lane.timer = setTimeout(() => {
      void this.tick(uid);
    }, delayMs);
  }

  private async tick(uid: string): Promise<void> {
    const lane = this.lane(uid);
    lane.timer = null;
    lane.running = true;
    try {
      const job = this.claimNextJob(uid);
      if (job) {
        await this.processJob(job);
        lane.nextAllowedAt = Date.now() + PACING_MS;
      }
    } finally {
      lane.running = false;
    }
    // An idle lane has no timer; the next enqueue wakes it. One with jobs left (or waiting out a
    // retry backoff) keeps ticking.
if (this.started && this.hasPending(uid)) this.scheduleTick(uid, lane, PACING_MS);
  }

  private hasPending(uid: string): boolean {
    return (
      this.db
        .select({ id: discogsQueueJobs.id })
        .from(discogsQueueJobs)
        .where(and(eq(discogsQueueJobs.status, "pending"), eq(discogsQueueJobs.uid, uid)))
        .limit(1)
        .all().length > 0
    );
  }

  private claimNextJob(uid: string): QueueJobRow | null {
    const now = Date.now();
    const pending = this.db
      .select()
      .from(discogsQueueJobs)
      .where(and(eq(discogsQueueJobs.status, "pending"), eq(discogsQueueJobs.uid, uid)))
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
    this.resetPause(job.uid);
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

  private resetPause(uid: string): void {
    const lane = this.lane(uid);
    lane.pause = null;
    lane.consecutiveFailures = 0;
    lane.capRetries = 0;
    lane.deadLettered = [];
  }

  /**
   * Discogs answered 5xx. The job is tried again at the lane's normal pace, with no pause; once it
   * has used its MAX_ATTEMPTS it is set aside as failed (its row keeps the error, like a dead-letter
   * queue) and the lane moves on. If DEAD_LETTER_OUTAGE_THRESHOLD jobs in a row are set aside it is
   * an outage, not bad releases: they go back to pending and the lane pauses.
   */
  private handleServerError(job: QueueJobRow, err: DiscogsServerError): void {
    const attempts = job.attempts + 1;

    if (attempts < MAX_ATTEMPTS) {
      this.db
        .update(discogsQueueJobs)
        .set({ status: "pending", attempts, errorMessage: err.message, updatedAt: new Date() })
        .where(eq(discogsQueueJobs.id, job.id))
        .run();
      logger.warn(`Job ${highlightId(job.id)} got a server error (attempt ${attempts}/${MAX_ATTEMPTS}), retrying: ${err.message}`);
      return;
    }

    const lane = this.lane(job.uid);
    if (lane.deadLettered.length + 1 >= DEAD_LETTER_OUTAGE_THRESHOLD) {
      const revived = lane.deadLettered;
      lane.deadLettered = [];
      if (revived.length > 0) {
        this.db
          .update(discogsQueueJobs)
          .set({ status: "pending", attempts: 0, updatedAt: new Date() })
          .where(inArray(discogsQueueJobs.id, revived))
          .run();
      }
      logger.warn(`${DEAD_LETTER_OUTAGE_THRESHOLD} jobs in a row got server errors, treating it as an outage`);
      this.pauseAndRetry({ ...job, attempts: 0 }, err);
      return;
    }

    lane.deadLettered.push(job.id);
    logger.warn(`Job ${highlightId(job.id)} set aside after ${attempts} server errors, moving on: ${err.message}`);
    this.markFailed(job, err.message, attempts, err);
  }

  /**
   * Discogs is erroring for this collector's token: keep the lane off Discogs for the next backoff
   * step and release its inline callers instead of making them wait. The job goes back untouched
   * (a pause costs no attempts), and a real outage still ends in `giveUp`.
   */
  private pauseAndRetry(job: QueueJobRow, err: DiscogsTransientError): void {
    const lane = this.lane(job.uid);
    lane.consecutiveFailures += 1;
    const stepMs = Math.min(PAUSE_BASE_MS * 2 ** (lane.consecutiveFailures - 1), PAUSE_CAP_MS);
    if (stepMs === PAUSE_CAP_MS) lane.capRetries += 1;

    if (lane.capRetries > MAX_CAP_RETRIES) {
      this.giveUp(job, err);
      return;
    }

    const backoffMs = Math.max(stepMs, err.retryAfterMs ?? 0);
    lane.pause = { retryAt: Date.now() + backoffMs, backoffMs };

    this.db
      .update(discogsQueueJobs)
      .set({ status: "pending", errorMessage: err.message, updatedAt: new Date() })
      .where(eq(discogsQueueJobs.id, job.id))
      .run();

    logger.warn(
      `Discogs is erroring, pausing the lane of ${job.uid} for ${backoffMs}ms (failure ${lane.consecutiveFailures} in a row): ${err.message}`,
    );

    const unavailable = new QueueUnavailableError("Discogs unavailable, retrying");
    for (const [id, waiter] of this.waiters) {
      if (waiter.uid !== job.uid) continue;
      waiter.reject(unavailable);
      this.waiters.delete(id);
    }
  }

  /** Discogs stayed down through every retry: fail the collector's unfinished work, so each of their runs ends in error. */
  private giveUp(job: QueueJobRow, err: DiscogsTransientError): void {
    logger.error(`Discogs still erroring after ${MAX_CAP_RETRIES} retries at the cap, giving up: ${err.message}`);
    this.resetPause(job.uid);
    this.abortRuns(job, `Gave up on Discogs: ${err.message}`, err, "lane");
  }

  /**
   * Fail `job` and every pending job of the affected runs (all the collector's runs, or just the
   * job's), then tell the listeners. Listeners run last, once the jobs are marked failed.
   */
  private abortRuns(job: QueueJobRow, errorMessage: string, cause: unknown, scope: "lane" | "run"): void {
    const pendingInScope = and(
      eq(discogsQueueJobs.status, "pending"),
      scope === "run" ? eq(discogsQueueJobs.runId, job.runId) : eq(discogsQueueJobs.uid, job.uid),
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
      this.waiters.get(id)?.reject(cause);
      this.waiters.delete(id);
    }

    this.markFailed(job, errorMessage, job.attempts, cause);
    for (const runId of runIds) {
      for (const listener of this.abortedListeners) listener(runId, cause);
    }
  }

  private handleFailure(job: QueueJobRow, err: unknown): void {
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (err instanceof DiscogsServerError) {
      this.handleServerError(job, err);
      return;
    }
    if (err instanceof DiscogsTransientError) {
      this.pauseAndRetry(job, err);
      return;
    }
    // Discogs answered, so the outage (if any) is over, even if this job still failed.
    this.resetPause(job.uid);

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
