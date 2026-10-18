import { parentPort, workerData } from "node:worker_threads";
import { createReadOnlyDb } from "../db/client";
import { READ_OPS, type ReadOpName } from "./read-ops";

/** A worker thread: one read-only SQLite connection, running one read op at a time. */
export interface WorkerRequest {
  id: number;
  op: ReadOpName;
  input: unknown;
}

export type WorkerResponse = { id: number; result: unknown } | { id: number; error: string };

const db = createReadOnlyDb((workerData as { dbPath: string }).dbPath);

parentPort!.on("message", (request: WorkerRequest) => {
  try {
    const op = READ_OPS[request.op] as (db: unknown, input: unknown) => unknown;
    const response: WorkerResponse = { id: request.id, result: op(db, request.input) };
    parentPort!.postMessage(response);
  } catch (err) {
    const response: WorkerResponse = { id: request.id, error: err instanceof Error ? err.message : String(err) };
    parentPort!.postMessage(response);
  }
});
