import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { and, eq } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, type Db } from "../db/client";
import {
  discogsQueueJobs,
  releases,
  scrapeReleases,
  scrapes,
  scrapeSearchMatches,
  scrapeUnmatched,
} from "../db/schema";
import { DiscogsQueue, NonRetryableError, SEARCH_PRIORITY } from "../queue/discogs-queue";
import { sanitiseSearchQuery } from "./sanitise";
import {
  createScrapeSearchHandler,
  failScrapeSearches,
  queueScrapeSearches,
  scrapeSearchRunId,
  settleScrapeSearch,
  unlinkSearchMatch,
} from "./scrape-search";

describe("sanitiseSearchQuery", () => {
  it("drops special characters but keeps apostrophes and letters of any script", () => {
    expect(sanitiseSearchQuery("Tony Hewitt & Grant Dell -Takin' You High")).toBe("Tony Hewitt Grant Dell Takin' You High");
    expect(sanitiseSearchQuery("  Massive Attack -Unfinished Sympathy (Kamouflage Loves Fred Remix) ")).toBe(
      "Massive Attack Unfinished Sympathy Kamouflage Loves Fred Remix",
    );
    expect(sanitiseSearchQuery("Sigur Rós / Ágætis – byrjun")).toBe("Sigur Rós Ágætis byrjun");
  });

  it("is empty when nothing but special characters is left", () => {
    expect(sanitiseSearchQuery("?!- /")).toBe("");
  });
});

describe("scrape searches", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;
  let scrapeId: number;
  const searchFirstReleaseId = vi.fn<(query: string, token: string) => Promise<number | null>>();

  const handler = () =>
    createScrapeSearchHandler({ db, queue, getToken: (uid) => (uid === "u1" ? "tok" : null), searchFirstReleaseId });
  const run = (position: number) => handler()({ uid: "u1", scrapeId, position }, { runId: scrapeSearchRunId(scrapeId), jobId: 1 });
  const matchRow = (position: number) =>
    db
      .select()
      .from(scrapeSearchMatches)
      .where(and(eq(scrapeSearchMatches.scrapeId, scrapeId), eq(scrapeSearchMatches.position, position)))
      .get();
  const jobs = () => db.select().from(discogsQueueJobs).all();

  function seedRelease(id: number) {
    db.insert(releases)
      .values({
        id,
        title: `Release ${id}`,
        year: 2000,
        genres: [],
        styles: [],
        formats: [],
        artists: [{ id, name: "Someone" }],
      })
      .run();
  }

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    queue = new DiscogsQueue(db);
    searchFirstReleaseId.mockReset();

    scrapeId = db.insert(scrapes).values({ uid: "u1", name: "Shop", createdAt: new Date() }).returning().get().id;
    db.insert(scrapeUnmatched)
      .values([
        { scrapeId, position: 0, line: "Denko" },
        { scrapeId, position: 1, line: "Artist -Title" },
        { scrapeId, position: 2, line: "?!" },
      ])
      .run();
  });

  afterEach(() => {
    queue.stop();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
  });

  const queueAll = () =>
    queueScrapeSearches(db, queue, "u1", scrapeId, [
      { position: 0, line: "Denko" },
      { position: 1, line: "Artist -Title" },
      { position: 2, line: "?!" },
    ]);

  it("queues a search job per line at search priority, skipping lines with nothing to search", () => {
    expect(queueAll()).toBe(2);

    expect(jobs().map((j) => [j.type, j.priority, j.runId])).toEqual([
      ["scrape_search", SEARCH_PRIORITY, scrapeSearchRunId(scrapeId)],
      ["scrape_search", SEARCH_PRIORITY, scrapeSearchRunId(scrapeId)],
    ]);
    expect(matchRow(1)).toMatchObject({ status: "queued", query: "Artist Title" });
    expect(matchRow(2)).toBeUndefined();
  });

  it("does not queue a line again while it is queued, matched or rejected", () => {
    queueAll();
    expect(queueAll()).toBe(0);
    db.update(scrapeSearchMatches).set({ status: "no_result" }).where(eq(scrapeSearchMatches.position, 0)).run();
    expect(queueAll()).toBe(1);
  });

  it("links a line to the first hit when the catalogue has it", async () => {
    seedRelease(100);
    queueAll();
    searchFirstReleaseId.mockResolvedValue(100);

    await run(0);

    expect(searchFirstReleaseId).toHaveBeenCalledWith("Denko", "tok");
    expect(matchRow(0)).toMatchObject({ status: "matched", releaseId: 100, committed: false, addedRelease: true });
    expect(db.select().from(scrapeReleases).all()).toEqual([{ scrapeId, releaseId: 100 }]);
    expect(db.select().from(scrapeUnmatched).all().map((r) => r.position)).toEqual([1, 2]);
  });

  it("fetches a hit the catalogue lacks, then links it when the fetch is done", async () => {
    queueAll();
    searchFirstReleaseId.mockResolvedValue(555);

    await run(0);

    expect(matchRow(0)).toMatchObject({ status: "fetching", releaseId: 555 });
    const fetchJob = jobs().find((j) => j.type === "release_detail")!;
    expect(fetchJob).toMatchObject({ priority: SEARCH_PRIORITY, runId: scrapeSearchRunId(scrapeId) });
    expect(fetchJob.payload).toEqual({ uid: "u1", releaseId: 555 });
    expect(db.select().from(scrapeReleases).all()).toEqual([]);

    seedRelease(555);
    settleScrapeSearch(db, { ...fetchJob, status: "done" });

    expect(matchRow(0)).toMatchObject({ status: "matched", releaseId: 555 });
    expect(db.select().from(scrapeReleases).all()).toEqual([{ scrapeId, releaseId: 555 }]);
  });

  it("fails the line when the release could not be fetched", async () => {
    queueAll();
    searchFirstReleaseId.mockResolvedValue(555);
    await run(0);
    const fetchJob = jobs().find((j) => j.type === "release_detail")!;

    settleScrapeSearch(db, { ...fetchJob, status: "failed" });

    expect(matchRow(0)).toMatchObject({ status: "failed" });
    expect(db.select().from(scrapeUnmatched).all()).toHaveLength(3);
  });

  it("queues one fetch for lines that found the same release", async () => {
    queueAll();
    searchFirstReleaseId.mockResolvedValue(555);

    await run(0);
    await run(1);

    expect(jobs().filter((j) => j.type === "release_detail")).toHaveLength(1);
  });

  it("records a search that found nothing", async () => {
    queueAll();
    searchFirstReleaseId.mockResolvedValue(null);

    await run(0);

    expect(matchRow(0)).toMatchObject({ status: "no_result", releaseId: null });
  });

  it("reuses an earlier answer for the same query instead of searching again", async () => {
    seedRelease(100);
    queueAll();
    searchFirstReleaseId.mockResolvedValue(100);
    await run(0);
    db.update(scrapeSearchMatches).set({ query: "Denko" }).where(eq(scrapeSearchMatches.position, 1)).run();

    await run(1);

    expect(searchFirstReleaseId).toHaveBeenCalledTimes(1);
    expect(matchRow(1)).toMatchObject({ status: "matched", releaseId: 100, addedRelease: false });
  });

  it("fails the job when the collector has no token", async () => {
    queueAll();

    await expect(
      createScrapeSearchHandler({ db, queue, getToken: () => null, searchFirstReleaseId })(
        { uid: "u1", scrapeId, position: 0 },
        { runId: scrapeSearchRunId(scrapeId), jobId: 1 },
      ),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("does nothing for a line that was deleted or already settled", async () => {
    await run(0);
    expect(searchFirstReleaseId).not.toHaveBeenCalled();
  });

  it("marks a line failed when its search job fails for good, and unfinished lines when the run aborts", () => {
    queueAll();
    settleScrapeSearch(db, { type: "scrape_search", runId: scrapeSearchRunId(scrapeId), status: "failed", payload: { uid: "u1", scrapeId, position: 0 } });
    expect(matchRow(0)).toMatchObject({ status: "failed" });

    failScrapeSearches(db, scrapeSearchRunId(scrapeId));
    expect(matchRow(1)).toMatchObject({ status: "failed" });
    failScrapeSearches(db, "enrichment-run");
  });

  describe("unlinking", () => {
    beforeEach(async () => {
      seedRelease(100);
      queueAll();
      searchFirstReleaseId.mockResolvedValue(100);
    });

    it("returns the line to unmatched as rejected and takes out the release it added", async () => {
      await run(0);

      unlinkSearchMatch(db, scrapeId, 0);

      expect(matchRow(0)).toMatchObject({ status: "rejected", committed: false });
      expect(db.select().from(scrapeReleases).all()).toEqual([]);
      expect(db.select().from(scrapeUnmatched).all().map((r) => r.position)).toContain(0);
      expect(queueAll()).toBe(0);
    });

    it("keeps a release another searched line still holds", async () => {
      await run(0);
      await run(1);

      unlinkSearchMatch(db, scrapeId, 0);
      expect(db.select().from(scrapeReleases).all()).toHaveLength(1);

      unlinkSearchMatch(db, scrapeId, 1);
      expect(db.select().from(scrapeReleases).all()).toEqual([]);
    });

    it("keeps a release the line's own matching had already found", async () => {
      db.insert(scrapeReleases).values({ scrapeId, releaseId: 100 }).run();
      await run(0);

      unlinkSearchMatch(db, scrapeId, 0);

      expect(db.select().from(scrapeReleases).all()).toHaveLength(1);
    });
  });
});
