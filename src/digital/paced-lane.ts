const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs tasks one at a time, each starting at least `gapMs` after the one before it, so a store sees
 * at most one request per gap however many checks are waiting. One lane per store, for the whole
 * server (the store sees our address, not the collector).
 */
export class PacedLane {
  private tail: Promise<unknown> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly gapMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = wait,
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const remaining = this.lastStart + this.gapMs - this.now();
      if (remaining > 0) await this.sleep(remaining);
      this.lastStart = this.now();
      return task();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
