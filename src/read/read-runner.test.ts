import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createDb, type Db } from "../db/client";
import { releases } from "../db/schema";
import { createWorkerReadRunner, type ReadRunner } from "./read-runner";

describe("worker read runner", () => {
  let dbPath: string;
  let db: Db;
  let runner: ReadRunner;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-read-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    db.insert(releases).values({ id: 1, title: "Stockholm", genres: [], styles: [], formats: [], artists: [{ id: 1, name: "The Persuader" }] }).run();
    runner = createWorkerReadRunner(dbPath, 1);
  });

  afterEach(async () => {
    await runner.close();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
  });

  it("lists releases on a worker thread's own connection", async () => {
    const result = await runner.run("listReleases", { query: { q: "persuader" }, uid: "u1" });

    expect(result).toMatchObject({ page: { total: 1, items: [{ releaseId: 1, title: "Stockholm" }] } });
  });

  it("returns a validation error instead of throwing", async () => {
    expect(await runner.run("listReleases", { query: { page: "0" }, uid: "u1" })).toEqual({
      error: "page must be a positive integer",
    });
  });

  it("drops a call that is aborted while it waits for a worker", async () => {
    const abort = new AbortController();
    const running = runner.run("listReleases", { query: {}, uid: "u1" });
    const waiting = runner.run("listReleases", { query: {}, uid: "u1" }, { signal: abort.signal });
    abort.abort();

    await expect(waiting).rejects.toThrow(/Aborted/);
    await expect(running).resolves.toBeDefined();
  });
}, 30_000);
