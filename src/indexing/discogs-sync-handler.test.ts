import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { and, eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb, type Db } from "../db/client";
import {
  collectionItems,
  discogsProfiles,
  discogsQueueJobs,
  enrichmentRuns,
  discogsTokens,
  fades,
  hiddenReleases,
  masterVersions,
  releases,
  wantlistItems,
} from "../db/schema";
import { DiscogsRateLimitError } from "../discogs-client";
import { NonRetryableError, PACING_MS, SYNC_PRIORITY, type EnqueueInput } from "../queue/discogs-queue";
import type { DiscogsListItem } from "../types/discogs-api";
import { createDiscogsSyncHandler } from "./discogs-sync-handler";

function item(id: number, masterId = 0, extra: Partial<DiscogsListItem> = {}): DiscogsListItem {
  return {
    id,
    date_added: "2024-02-19T02:39:32-08:00",
    basic_information: {
      id,
      master_id: masterId,
      title: `Title ${id}`,
      artists: [{ id: id * 10, name: `Artist ${id}` }],
    },
    ...extra,
  };
}

const page = (items: DiscogsListItem[], pages = 1) => ({
  pagination: { page: 1, pages, per_page: 100, items: items.length },
});

describe("discogs_sync handler", () => {
  let dbPath: string;
  let db: Db;
  let wants: DiscogsListItem[][];
  let collection: DiscogsListItem[][];
  const getWantlistPage = vi.fn();
  const getCollectionPage = vi.fn();
  const sleep = vi.fn(async () => {});
  const enqueued: EnqueueInput[] = [];
  const context = { runId: "r", jobId: 1 };

  const handler = (token: string | null = "tok") =>
    createDiscogsSyncHandler({
      db,
      enqueue: (job) => enqueued.push(job),
      getToken: () => token,
      getWantlistPage,
      getCollectionPage,
      sleep,
    });
  const sync = (uid = "u1") => handler()({ uid }, context);

  /** Serves `wants` and `collection` as pages of items, in order. */
  function serve() {
    getWantlistPage.mockImplementation(async (_u: string, n: number) => ({
      ...page([], wants.length),
      wants: wants[n - 1],
    }));
    getCollectionPage.mockImplementation(async (_u: string, n: number) => ({
      ...page([], collection.length),
      releases: collection[n - 1],
    }));
  }

  const ids = (rows: { releaseId: number }[]) => rows.map((row) => row.releaseId).sort((a, b) => a - b);
  const hidden = (uid = "u1") =>
    ids(db.select().from(hiddenReleases).where(eq(hiddenReleases.uid, uid)).all());
  const lookups = () => enqueued.filter((job) => job.type === "fade_lookup");
  const fadeRows = (uid = "u1") => db.select().from(fades).where(eq(fades.uid, uid)).all();

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    for (const uid of ["u1", "u2"]) {
      db.insert(discogsTokens).values({ uid, tokenEncrypted: "x", username: `user-${uid}`, createdAt: new Date() }).run();
    }
    wants = [[item(1, 100), item(2)]];
    collection = [[item(3, 200), item(4)]];
    getWantlistPage.mockReset();
    getCollectionPage.mockReset();
    serve();
    sleep.mockClear();
    enqueued.length = 0;
  });

  afterEach(() => {
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  describe("the mirror", () => {
    it("stores both lists for the collector, with null for a missing master", async () => {
      await sync();

      expect(db.select().from(wantlistItems).all()).toEqual([
        {
          uid: "u1",
          releaseId: 1,
          masterId: 100,
          title: "Title 1",
          artists: [{ id: 10, name: "Artist 1" }],
          addedAt: new Date("2024-02-19T10:39:32Z"),
        },
        expect.objectContaining({ uid: "u1", releaseId: 2, masterId: null }),
      ]);
      expect(db.select().from(collectionItems).all()).toEqual([
        { uid: "u1", releaseId: 3, masterId: 200, title: "Title 3", artists: [{ id: 30, name: "Artist 3" }] },
        { uid: "u1", releaseId: 4, masterId: null, title: "Title 4", artists: [{ id: 40, name: "Artist 4" }] },
      ]);
    });

    it("asks Discogs for the collector's username with their token, wantlist first", async () => {
      await sync();

      expect(getWantlistPage).toHaveBeenCalledWith("user-u1", 1, "tok");
      expect(getCollectionPage).toHaveBeenCalledWith("user-u1", 1, "tok");
      expect(getWantlistPage.mock.invocationCallOrder[0]).toBeLessThan(getCollectionPage.mock.invocationCallOrder[0]!);
    });

    it("keeps one row for a release owned twice", async () => {
      collection = [[item(3, 200), item(3, 200)]];

      await sync();

      expect(db.select().from(collectionItems).all()).toHaveLength(1);
    });

    it("keeps a release that is not in the catalogue", async () => {
      await sync();

      expect(hidden()).toEqual([1, 2, 3, 4]);
    });

    it("leaves addedAt null when Discogs sends no usable date", async () => {
      const undated = item(1);
      delete undated.date_added;
      wants = [[undated, item(2, 0, { date_added: "never" })]];

      await sync();

      expect(db.select().from(wantlistItems).all().map((row) => row.addedAt)).toEqual([null, null]);
    });

    it("pages through every page of both lists, spacing the requests", async () => {
      wants = [[item(1)], [item(2)], [item(5)]];
      collection = [[item(3)], [item(4)]];

      await sync();

      expect(getWantlistPage.mock.calls.map((call) => call[1])).toEqual([1, 2, 3]);
      expect(getCollectionPage.mock.calls.map((call) => call[1])).toEqual([1, 2]);
      // Between consecutive requests: 2 gaps in the wantlist, 1 between the lists, 1 in the collection.
      expect(sleep).toHaveBeenCalledTimes(4);
      expect(sleep).toHaveBeenCalledWith(PACING_MS);
      expect(ids(db.select().from(wantlistItems).all())).toEqual([1, 2, 5]);
      expect(ids(db.select().from(collectionItems).all())).toEqual([3, 4]);
    });

    it("handles empty lists", async () => {
      wants = [[]];
      collection = [[]];

      await sync();

      expect(db.select().from(hiddenReleases).all()).toEqual([]);
      expect(db.select().from(discogsProfiles).get()).toMatchObject({ collectionCount: 0, wantlistCount: 0 });
    });

    it("drops an item taken off a list and keeps the others", async () => {
      await sync();
      wants = [[item(1, 100)]];
      collection = [[item(3, 200)]];

      await sync();

      expect(ids(db.select().from(wantlistItems).all())).toEqual([1]);
      expect(ids(db.select().from(collectionItems).all())).toEqual([3]);
    });
  });

  describe("hiding", () => {
    it("deletes the hidden row of an item that left both lists", async () => {
      await sync();
      wants = [[item(1, 100)]];
      collection = [[]];

      await sync();

      expect(hidden()).toEqual([1]);
    });

    it("keeps an item hidden while it is still on the other list", async () => {
      await sync();
      wants = [[]];
      collection = [[item(1, 100), item(3, 200)]];

      await sync();

      expect(hidden()).toEqual([1, 3]);
      expect(db.select().from(wantlistItems).all()).toEqual([]);
    });

    it("hides each item once however often it syncs", async () => {
      await sync();
      await sync();

      expect(hidden()).toEqual([1, 2, 3, 4]);
    });

    it("hides a release that is on both lists once", async () => {
      wants = [[item(1, 100)]];
      collection = [[item(1, 100)]];

      await sync();

      expect(hidden()).toEqual([1]);
    });
  });

  describe("fades", () => {
    it("deletes the release fade on a hidden item, and keeps the other release fades", async () => {
      db.insert(fades)
        .values([
          { uid: "u1", kind: "release", id: 2, createdAt: new Date() },
          { uid: "u1", kind: "release", id: 4, createdAt: new Date() },
          { uid: "u1", kind: "release", id: 99, createdAt: new Date() },
        ])
        .run();

      await sync();

      expect(fadeRows().filter((fade) => fade.kind === "release").map((fade) => fade.id)).toEqual([99]);
    });

    it("fades the master of an item once, with the title Discogs gave, and queues its lookup", async () => {
      wants = [[item(1, 100), item(2, 100)]];
      collection = [[item(3, 100)]];

      await sync();

      expect(fadeRows()).toEqual([
        {
          uid: "u1",
          kind: "master",
          id: 100,
          createdAt: expect.any(Date),
          lookupStatus: "pending",
          title: "Title 1",
          artists: [{ id: 10, name: "Artist 1" }],
        },
      ]);
      expect(lookups()).toEqual([
        {
          runId: "fade:u1:100",
          type: "fade_lookup",
          payload: { uid: "u1", kind: "master", id: 100 },
          priority: SYNC_PRIORITY,
        },
      ]);
    });

    it("only hides an item without a master", async () => {
      wants = [[item(2)]];
      collection = [[item(4)]];

      await sync();

      expect(fadeRows()).toEqual([]);
      expect(lookups()).toEqual([]);
      expect(hidden()).toEqual([2, 4]);
    });

    it("leaves a master fade the collector made themselves as it is, and queues nothing for it", async () => {
      const madeAt = new Date("2026-01-01T00:00:00Z");
      db.insert(fades)
        .values({ uid: "u1", kind: "master", id: 100, createdAt: madeAt, lookupStatus: "done", title: "Mine" })
        .run();

      await sync();

      expect(fadeRows().find((fade) => fade.id === 100)).toMatchObject({ createdAt: madeAt, title: "Mine", lookupStatus: "done" });
      expect(lookups().map((job) => (job.payload as { id: number }).id)).toEqual([200]);
    });

    it("marks the fade done without a lookup when the master's versions are already stored", async () => {
      db.insert(masterVersions).values({ masterId: 100, releaseId: 1 }).run();

      await sync();

      expect(fadeRows().find((fade) => fade.id === 100)?.lookupStatus).toBe("done");
      expect(lookups().map((job) => (job.payload as { id: number }).id)).toEqual([200]);
    });

    it("keeps the master fade when the item leaves its list", async () => {
      await sync();
      wants = [[]];
      collection = [[]];

      await sync();

      expect(hidden()).toEqual([]);
      expect(fadeRows().map((fade) => fade.id).sort()).toEqual([100, 200]);
    });

    it("does not queue a lookup twice for a master faded by an earlier sync", async () => {
      await sync();
      enqueued.length = 0;

      await sync();

      expect(lookups()).toEqual([]);
    });
  });

  describe("the profile", () => {
    it("takes the counts from the mirrored lists and records the sync", async () => {
      db.insert(discogsProfiles)
        .values({ uid: "u1", username: "user-u1", collectionCount: 99, wantlistCount: 99, fetchedAt: new Date(0) })
        .run();

      await sync();

      const row = db.select().from(discogsProfiles).where(eq(discogsProfiles.uid, "u1")).get()!;
      expect(row).toMatchObject({ username: "user-u1", collectionCount: 2, wantlistCount: 2 });
      expect(row.lastSyncedAt).toBeInstanceOf(Date);
      expect(row.fetchedAt.getTime()).toBeGreaterThan(0);
    });

    it("creates the profile when there was none", async () => {
      await sync();

      expect(db.select().from(discogsProfiles).all()).toHaveLength(1);
    });
  });

  describe("when it cannot finish", () => {
    it("writes nothing when a later page fails, and keeps the previous sync", async () => {
      await sync();
      const mirrorBefore = db.select().from(wantlistItems).all();
      const fadesBefore = fadeRows();
      wants = [[item(7, 700)], [item(8)]];
      getWantlistPage.mockImplementation(async (_u: string, n: number) => {
        if (n === 2) throw new DiscogsRateLimitError("slow down", 30_000);
        return { ...page([], 2), wants: wants[0] };
      });

      await expect(sync()).rejects.toThrow(DiscogsRateLimitError);

      expect(db.select().from(wantlistItems).all()).toEqual(mirrorBefore);
      expect(hidden()).toEqual([1, 2, 3, 4]);
      expect(fadeRows()).toEqual(fadesBefore);
    });

    it("writes nothing when the collection fails after the wantlist came in", async () => {
      getCollectionPage.mockRejectedValue(new DiscogsRateLimitError("slow down"));

      await expect(sync()).rejects.toThrow(DiscogsRateLimitError);

      expect(db.select().from(wantlistItems).all()).toEqual([]);
      expect(db.select().from(hiddenReleases).all()).toEqual([]);
      expect(db.select().from(discogsProfiles).all()).toEqual([]);
      expect(lookups()).toEqual([]);
    });

    it("fails for good without a token, without asking Discogs", async () => {
      await expect(handler(null)({ uid: "u1" }, context)).rejects.toThrow(NonRetryableError);
      await expect(handler()({ uid: "nobody" }, context)).rejects.toThrow(NonRetryableError);

      expect(getWantlistPage).not.toHaveBeenCalled();
    });
  });

  describe("another collector", () => {
    it("is never read or changed", async () => {
      db.insert(wantlistItems).values({ uid: "u2", releaseId: 1, masterId: 100, title: "Theirs", artists: [], addedAt: null }).run();
      db.insert(collectionItems).values({ uid: "u2", releaseId: 9, masterId: null, title: "Theirs", artists: [] }).run();
      db.insert(hiddenReleases).values([{ uid: "u2", releaseId: 1 }, { uid: "u2", releaseId: 9 }]).run();
      db.insert(fades).values({ uid: "u2", kind: "release", id: 2, createdAt: new Date() }).run();

      await sync();

      expect(db.select().from(wantlistItems).where(eq(wantlistItems.uid, "u2")).all()).toHaveLength(1);
      expect(db.select().from(collectionItems).where(eq(collectionItems.uid, "u2")).all()).toHaveLength(1);
      expect(hidden("u2")).toEqual([1, 9]);
      expect(fadeRows("u2")).toHaveLength(1);
      expect(db.select().from(discogsProfiles).where(eq(discogsProfiles.uid, "u2")).all()).toEqual([]);
    });

    it("can fade the same master for both collectors", async () => {
      await sync("u1");
      await sync("u2");

      for (const uid of ["u1", "u2"]) {
        const row = db
          .select()
          .from(fades)
          .where(and(eq(fades.uid, uid), eq(fades.kind, "master"), eq(fades.id, 100)))
          .get();
        expect(row).toBeDefined();
      }
    });
  });

  describe("wantlist availability (fader-ui#143)", () => {
    const jobs = () => enqueued.filter((job) => job.type === "release_detail");
    const queuedIds = () => jobs().map((job) => (job.payload as { releaseId: number }).releaseId).sort((a, b) => a - b);
    const store = (id: number, extra: Partial<typeof releases.$inferInsert> = {}) =>
      db.insert(releases).values({ id, title: `Release ${id}`, genres: [], styles: [], formats: [], artists: [], ...extra }).run();
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);

    it("queues a priority 0 release_detail job for each wantlist release that is not stored, on its own label, without a run", async () => {
      await sync();

      expect(queuedIds()).toEqual([1, 2]);
      for (const job of jobs()) {
        expect(job.runId).toBe("wantlist-availability:u1");
        expect(job.priority ?? 0).toBe(0);
        expect(job.priority ?? 0).toBeLessThan(SYNC_PRIORITY);
      }
      expect(db.select().from(enrichmentRuns).all()).toEqual([]);
    });

    it("never queues the collection", async () => {
      await sync();

      expect(queuedIds()).not.toContain(3);
      expect(queuedIds()).not.toContain(4);
    });

    it("queues a stored release that was never enriched, and one whose count is over a day old", async () => {
      store(1);
      store(2, { enrichedAt: hoursAgo(30), numForSale: 4, numForSaleAt: hoursAgo(25) });

      await sync();

      expect(queuedIds()).toEqual([1, 2]);
    });

    it("queues nothing for a release fetched within a day, even by another collector", async () => {
      store(1, { enrichedAt: hoursAgo(2), numForSale: 4, numForSaleAt: hoursAgo(2) });
      store(2, { enrichedAt: hoursAgo(23), numForSale: null, numForSaleAt: hoursAgo(23) });

      await sync();

      expect(queuedIds()).toEqual([]);
    });

    it("queues an enriched release that has no count yet", async () => {
      store(1, { enrichedAt: hoursAgo(1) });
      store(2, { enrichedAt: hoursAgo(1), numForSaleAt: hoursAgo(1) });

      await sync();

      expect(queuedIds()).toEqual([1]);
    });

    it("leaves out a release Discogs no longer has", async () => {
      store(1, { missingAt: new Date() });

      await sync();

      expect(queuedIds()).toEqual([2]);
    });

    it("leaves out a release another job has queued", async () => {
      db.insert(discogsQueueJobs)
        .values({
          uid: "u2",
          runId: "run",
          type: "release_detail",
          payload: { uid: "u2", releaseId: 2 },
          priority: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run();

      await sync();

      expect(queuedIds()).toEqual([1]);
    });

    it("queues nothing when the sync fails part-way", async () => {
      getCollectionPage.mockRejectedValue(new DiscogsRateLimitError("slow down"));

      await expect(sync()).rejects.toBeInstanceOf(DiscogsRateLimitError);

      expect(jobs()).toEqual([]);
    });
  });
});
