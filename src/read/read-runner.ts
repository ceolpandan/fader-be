import path from "node:path";
import { Worker } from "node:worker_threads";
import type { Db } from "../db/client";
import { logger } from "../util/logger";
import { READ_OPS, type ReadOpInput, type ReadOpName, type ReadOpResult } from "./read-ops";
import type { WorkerRequest, WorkerResponse } from "./read-worker";

export interface RunOptions {
  /** Abort a call still waiting for a free worker (e.g. the client hung up); one already running finishes. */
  signal?: AbortSignal;
}

/** Where the slow read queries run: on a worker thread in the server, inline in tests. */
export interface ReadRunner {
  run<K extends ReadOpName>(op: K, input: ReadOpInput<K>, options?: RunOptions): Promise<Awaited<ReadOpResult<K>>>;
  close(): Promise<void>;
}

/** Runs the op on the caller's connection, on the calling thread. For tests and tools. */
export function createInlineReadRunner(db: Db): ReadRunner {
  return {
    async run(op, input) {
      const fn = READ_OPS[op] as (db: Db, input: unknown) => never;
      return fn(db, input);
    },
    async close() {},
  };
}

interface Task {
  request: WorkerRequest;
  resolve: (result: never) => void;
  reject: (cause: unknown) => void;
  signal: AbortSignal | undefined;
}

interface Slot {
  worker: Worker;
  current: Task | null;
}

/**
 * A fixed pool of worker threads, each with its own read-only connection to the database file
 * (WAL lets them read while the main thread writes). A call waits in a FIFO queue until a worker
 * is free, so a burst of heavy searches can never use more than `size` threads or starve the
 * event loop.
 */
export function createWorkerReadRunner(dbPath: string, size = 2): ReadRunner {
  // Under ts-node-dev the worker is a .ts file and needs the TypeScript loader; compiled, it is .js.
  const file = path.join(__dirname, `read-worker${path.extname(__filename)}`);
  const execArgv = file.endsWith(".ts") ? ["-r", "ts-node/register/transpile-only"] : [];

  const waiting: Task[] = [];
  const slots: Slot[] = [];
  let nextId = 1;
  let closed = false;

  function spawn(): Slot {
    const slot: Slot = { worker: new Worker(file, { workerData: { dbPath }, execArgv }), current: null };
    slot.worker.on("message", (response: WorkerResponse) => {
      const task = slot.current;
      slot.current = null;
      if (task?.request.id === response.id) {
        if ("error" in response) task.reject(new Error(response.error));
        else task.resolve(response.result as never);
      }
      dispatch();
    });
    slot.worker.on("error", (err) => {
      logger.error("Read worker crashed", err);
      slot.current?.reject(err);
      slot.current = null;
      if (closed) return;
      slots[slots.indexOf(slot)] = spawn();
      dispatch();
    });
    return slot;
  }

  function dispatch(): void {
    for (const slot of slots) {
      if (slot.current) continue;
      let task = waiting.shift();
      while (task?.signal?.aborted) task = waiting.shift();
      if (!task) return;
      slot.current = task;
      slot.worker.postMessage(task.request);
    }
  }

  for (let i = 0; i < size; i++) slots.push(spawn());

  return {
    run(op, input, options = {}) {
      if (closed) return Promise.reject(new Error("Read runner is closed"));
      return new Promise((resolve, reject) => {
        const { signal } = options;
        const task: Task = { request: { id: nextId++, op, input }, resolve: resolve as never, reject, signal };
        signal?.addEventListener(
          "abort",
          () => {
            const queued = waiting.indexOf(task);
            if (queued === -1) return;
            waiting.splice(queued, 1);
            reject(new Error("Aborted before a read worker was free"));
          },
          { once: true },
        );
        waiting.push(task);
        dispatch();
      });
    },
    async close() {
      closed = true;
      for (const task of waiting.splice(0)) task.reject(new Error("Read runner is closed"));
      await Promise.all(slots.map((slot) => slot.worker.terminate()));
    },
  };
}
