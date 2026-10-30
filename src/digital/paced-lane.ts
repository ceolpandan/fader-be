const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Priority of a request a collector is waiting on (one item's check), ahead of a scan's (0). */
export const CHECK_PRIORITY = 1;

interface Waiting {
  task: () => Promise<unknown>;
  priority: number;
  resolve: (value: unknown) => void;
  reject: (cause: unknown) => void;
}

/**
 * Runs tasks one at a time, each starting at least `gapMs` after the one before it, so a store sees
 * at most one request per gap however many checks are waiting. One lane per store, for the whole
 * server (the store sees our address, not the collector). The task that starts next is the
 * waiting one with the highest priority, the oldest of those: a request a person waits on
 * overtakes a scan's.
 */
export class PacedLane {
  private readonly waiting: Waiting[] = [];
  private draining = false;
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(
    readonly gapMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = wait,
  ) {}

  run<T>(task: () => Promise<T>, priority = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({ task, priority, resolve: resolve as (value: unknown) => void, reject });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.waiting.length > 0) {
        const remaining = this.lastStart + this.gapMs - this.now();
        if (remaining > 0) await this.sleep(remaining);
        // Picked after the wait, so a task that arrived during it can take the turn.
        const job = this.takeNext();
        this.lastStart = this.now();
        try {
          job.resolve(await job.task());
        } catch (cause) {
          job.reject(cause);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private takeNext(): Waiting {
    let best = 0;
    for (let i = 1; i < this.waiting.length; i++) {
      if (this.waiting[i]!.priority > this.waiting[best]!.priority) best = i;
    }
    return this.waiting.splice(best, 1)[0]!;
  }
}
