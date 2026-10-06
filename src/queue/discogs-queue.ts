import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { discogsQueueJobs, type QueueJobPayloadMap, type QueueJobType } from "../db/schema";
import { logger, highlightId } from "../util/logger";

export const PACING_MS = 1300;
export const MAX_ATTEMPTS = 3;
/** Priority for work a user is actively waiting on (vs. 0 for background indexing). */
export const INLINE_PRIORITY = 10;
export const DEFAULT_WAIT_TIMEOUT_MS = 20_000;
export const BASE_BACKOFF_MS = 2000;

export class NonRetryableError extends Error {}

/** `enqueueAndWait` gave up waiting; the job itself is still queued and will run. */
export class QueueWaitTimeoutError extends Error {}

export interface JobHandlerContext {
  runId: string;
  jobId: number;
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

export class DiscogsQueue {
  private readonly handlers = new Map<QueueJobType, JobHandler>();
  private readonly backoffUntil = new Map<number, number>();
  private readonly settledListeners: SettledListener[] = [];
  private readonly waiters = new Map<
    number,
    { resolve: () => void; reject: (cause: unknown) => void }
  >();
  private readonly inFlight = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly db: Db) {}

  registerHandler<T extends QueueJobType>(type: T, handler: JobHandler<QueueJobPayloadMap[T]>): void {
    this.handlers.set(type, handler as JobHandler);
  }

  /** Notified once a job reaches a terminal state (done or failed) — never on a retry. */
  onSettled(listener: SettledListener): void {
    this.settledListeners.push(listener);
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
    this.scheduleNextTick(PACING_MS);
  }

  private claimNextJob(): QueueJobRow | null {
    const now = Date.now();
    const pending = this.db
      .select()
      .from(discogsQueueJobs)
      .where(eq(discogsQueueJobs.status, "pending"))
      .orderBy(desc(discogsQueueJobs.priority), asc(discogsQueueJobs.id))
      .all();

    const eligible = pending.find((job) => (this.backoffUntil.get(job.id) ?? 0) <= now);
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
      await handler(job.payload, { runId: job.runId, jobId: job.id });
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

  private handleFailure(job: QueueJobRow, err: unknown): void {
    const errorMessage = err instanceof Error ? err.message : String(err);
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
