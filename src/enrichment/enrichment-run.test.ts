import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "../db/client";
import { discogsQueueJobs, discogsTokens, enrichmentRuns, releases } from "../db/schema";
import { createReleaseDetailHandler } from "../indexing/release-detail-handler";
import { DiscogsQueue, PACING_MS } from "../queue/discogs-queue";
import type { DiscogsRelease } from "../types/discogs-api";
import { finishRunsWithNothingLeft, finishRunWhenSettled, startRun } from "./enrichment-run";

describe("an enrichment run across a server restart", () => {
  let dbPath: string;
  let db: Db;
  const queues: DiscogsQueue[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    db.insert(discogsTokens).values({ uid: "u1", tokenEncrypted: "x", username: "dan", createdAt: new Date() }).run();
    for (const id of [1, 2, 3]) {
      db.insert(releases).values({ id, title: `R${id}`, genres: [], styles: [], formats: [], artists: [] }).run();
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const queue of queues) queue.stop();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  /** A server process starting up on the stored database, as `index.ts` does. */
  function boot(getRelease: (id: number) => Promise<DiscogsRelease>): DiscogsQueue {
    const queue = new DiscogsQueue(db);
    queues.push(queue);
    queue.registerHandler(
      "release_detail",
      createReleaseDetailHandler({ db, getToken: () => "token", getRelease }),
    );
    queue.onSettled((job) => finishRunWhenSettled(db, job));
    finishRunsWithNothingLeft(db);
    queue.start();
    return queue;
  }

  const run = () => db.select().from(enrichmentRuns).get()!;
  const enriched = () =>
    db
      .select({ id: releases.id, enrichedAt: releases.enrichedAt })
      .from(releases)
      .all()
      .filter((row) => row.enrichedAt !== null)
      .map((row) => row.id);

  it("carries on with the jobs that were left, including the one that was being fetched", async () => {
    const first = new DiscogsQueue(db);
    const started = startRun(db, first, "u1", "", false);
    expect("run" in started).toBe(true);
    const [a, b] = db.select().from(discogsQueueJobs).all();
    // The server stopped with one release fetched, one in flight and one not started.
    db.update(discogsQueueJobs).set({ status: "done" }).where(eq(discogsQueueJobs.id, a!.id)).run();
    db.update(discogsQueueJobs).set({ status: "processing" }).where(eq(discogsQueueJobs.id, b!.id)).run();
    db.update(releases).set({ enrichedAt: new Date(1) }).where(eq(releases.id, 1)).run();

    const fetched: number[] = [];
    boot(async (id) => {
      fetched.push(id);
      return { id, title: `R${id}`, artists: [], resource_url: "" } as DiscogsRelease;
    });
    expect(run().status).toBe("running");
    await vi.advanceTimersByTimeAsync(PACING_MS * 3);

    expect(fetched).toEqual([2, 3]);
    expect(enriched().sort()).toEqual([1, 2, 3]);
    expect(run()).toMatchObject({ status: "done", total: 3 });
    expect(run().finishedAt).not.toBeNull();
  });

  it("finishes a run whose last job settled just before the server stopped", () => {
    const first = new DiscogsQueue(db);
    startRun(db, first, "u1", "", false);
    db.update(discogsQueueJobs).set({ status: "done" }).run();
    expect(run().status).toBe("running");

    boot(async () => {
      throw new Error("nothing should be fetched");
    });

    expect(run().status).toBe("done");
  });
});
