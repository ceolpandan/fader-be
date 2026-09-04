import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { discogsQueueJobs, type QueueJobPayloadMap, type QueueJobType } from "../db/schema";
import { logger, highlightId } from "../util/logger";

export const PACING_MS = Math.ceil(60_000 / 59);
export const MAX_ATTEMPTS = 3;
export const BASE_BACKOFF_MS = 2000;

export class NonRetryableError extends Error {}

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
}

export type SettledListener = (job: QueueJobRow) => void;

export class DiscogsQueue {
  private readonly handlers = new Map<QueueJobType, JobHandler>();
  private readonly backoffUntil = new Map<number, number>();
  private readonly settledListeners: SettledListener[] = [];
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
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all();

    return inserted!.id;
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
      .orderBy(asc(discogsQueueJobs.id))
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

  private markFailed(job: QueueJobRow, errorMessage: string, attempts = job.attempts): void {
    const updatedAt = new Date();
    this.db
      .update(discogsQueueJobs)
      .set({ status: "failed", attempts, errorMessage, updatedAt })
      .where(eq(discogsQueueJobs.id, job.id))
      .run();
    this.backoffUntil.delete(job.id);
    logger.error(`Job ${highlightId(job.id)} failed permanently: ${errorMessage}`);
    this.notifySettled({ ...job, status: "failed", attempts, errorMessage, updatedAt });
  }

  private notifySettled(job: QueueJobRow): void {
    for (const listener of this.settledListeners) listener(job);
  }

  private handleFailure(job: QueueJobRow, err: unknown): void {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const attempts = job.attempts + 1;

    if (err instanceof NonRetryableError || attempts >= MAX_ATTEMPTS) {
      this.markFailed(job, errorMessage, attempts);
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
