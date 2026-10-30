import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, type Db } from "../db/client";
import { digitalMatches, releases, wantlistItems } from "../db/schema";
import { DigitalScanner, settleScansAfterRestart } from "./digital-scan";
import type { DigitalStores } from "./digital-stores";
import { PacedLane } from "./paced-lane";
import { StoreSessions } from "./store-sessions";
import {
  StoreSessionExpiredError,
  StoreUnavailableError,
  type DigitalStore,
  type StoreHit,
  type StoreSession,
} from "./types";

const SESSION: StoreSession = { headers: { cookie: "a=1" } };
const ARTIST = { id: 1, name: "Artist" };

const albumOf = (title: string): StoreHit => ({
  kind: "album",
  title,
  artist: "Artist",
  album: null,
  url: `https://artist.bandcamp.com/album/${title.toLowerCase()}`,
});
const trackOf = (title: string): StoreHit => ({
  kind: "track",
  title,
  artist: "Artist",
  album: null,
  url: `https://artist.bandcamp.com/track/${title.toLowerCase()}`,
});

describe("DigitalScanner", () => {
  let dbPath: string;
  let db: Db;
  let sessions: StoreSessions;
  let searchReleases: ReturnType<typeof vi.fn<(session: StoreSession, query: string) => Promise<StoreHit[]>>>;
  let searchTracks: ReturnType<typeof vi.fn<(session: StoreSession, query: string) => Promise<StoreHit[]>>>;
  let sleeps: number[];
  let scanner: DigitalScanner;

  /** `One` is an album on the store, `Two` has only its first track there, the rest are nowhere. */
  const defaultSearchReleases = async (_session: StoreSession, query: string) => (query.includes("One") ? [albumOf("One")] : []);
  const defaultSearchTracks = async (_session: StoreSession, query: string) =>
    query.includes("Twist") ? [trackOf("Twist")] : [];

  function addRelease(id: number, title: string, tracks: string[] = ["Side", "Flip"]) {
    db.insert(releases)
      .values({
        id,
        title,
        videos: [],
        tracklist: tracks.map((t, i) => ({ position: `A${i + 1}`, title: t })),
        year: 2018,
        genres: [],
        styles: [],
        formats: [],
        labels: [],
        artists: [ARTIST],
        masterId: null,
      })
      .run();
    addWantlist(id, title);
  }

  function addWantlist(releaseId: number, title: string, uid = "u1") {
    db.insert(wantlistItems).values({ uid, releaseId, masterId: null, title, artists: [ARTIST], addedAt: null }).run();
  }

  const scan = () => scanner.current("u1", "bandcamp")!;
  const untilStatus = (status: string) => vi.waitFor(() => expect(scan().status).toBe(status));

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });

    searchReleases = vi.fn(defaultSearchReleases);
    searchTracks = vi.fn(defaultSearchTracks);
    const store: DigitalStore = {
      id: "bandcamp",
      searchReleases: (...args) => searchReleases(...args),
      searchTracks: (...args) => searchTracks(...args),
    };
    sessions = new StoreSessions();
    sessions.set("u1", "bandcamp", SESSION);
    const digital: DigitalStores = {
      stores: { bandcamp: { store, lane: new PacedLane(0), host: "bandcamp.com" } },
      sessions,
    };
    sleeps = [];
    scanner = new DigitalScanner(db, digital, async (ms) => void sleeps.push(ms));

    addRelease(1, "One");
    addRelease(2, "Two", ["Twist", "Flip"]);
    addRelease(3, "Three");
  });

  afterEach(() => {
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  describe("start", () => {
    it("checks every wantlist item with a release stored and counts the Unmatched ones as skipped", async () => {
      addWantlist(900, "Not stored");

      expect(scanner.start("u1", "bandcamp", false)).toMatchObject({ scan: { status: "running", total: 3, skipped: 1 } });
      await untilStatus("done");

      expect(scan()).toMatchObject({ albumCount: 1, tracksCount: 1, noneCount: 1, failedReleaseIds: [], currentReleaseId: null });
      const stored = db.select().from(digitalMatches).all();
      expect(stored.map((m) => [m.releaseId, m.status])).toEqual([
        [1, "album"],
        [2, "tracks"],
        [3, "none"],
      ]);
    });

    it("counts requests: an album found takes one, a miss takes the album search and a search for each track", async () => {
      scanner.start("u1", "bandcamp", false);
      await untilStatus("done");

      // One: 1. Two and Three: 1 album search + 2 track searches each.
      expect(scan().requestsDone).toBe(1 + 3 + 3);
      expect(scan().requestsPlanned).toBe(3 + 3 + 3);
      expect(scan().plannedDone).toBe(scan().requestsPlanned);
    });

    it("leaves the items that already have a result alone", async () => {
      db.insert(digitalMatches)
        .values({ releaseId: 1, store: "bandcamp", status: "none", tracks: [], trackCount: 2, checkedAt: new Date("2020-01-01") })
        .run();

      expect(scanner.start("u1", "bandcamp", false)).toMatchObject({ scan: { total: 2 } });
      await untilStatus("done");

      expect(db.select().from(digitalMatches).all().find((m) => m.releaseId === 1)?.status).toBe("none");
    });

    it("checks the items that already have a result again on a recheck", async () => {
      db.insert(digitalMatches)
        .values({ releaseId: 1, store: "bandcamp", status: "none", tracks: [], trackCount: 2, checkedAt: new Date("2020-01-01") })
        .run();

      expect(scanner.start("u1", "bandcamp", true)).toMatchObject({ scan: { total: 3, recheck: true } });
      await untilStatus("done");

      expect(db.select().from(digitalMatches).all().find((m) => m.releaseId === 1)?.status).toBe("album");
    });

    it("is done at once when nothing needs checking", () => {
      db.delete(wantlistItems).run();
      expect(scanner.start("u1", "bandcamp", false)).toMatchObject({ scan: { status: "done", total: 0 } });
    });

    it("only scans the collector's own wantlist", async () => {
      db.delete(wantlistItems).run();
      addWantlist(1, "One", "u2");
      scanner.start("u1", "bandcamp", false);
      await untilStatus("done");
      expect(scan().total).toBe(0);
      expect(searchReleases).not.toHaveBeenCalled();
    });

    it("asks for a curl first when there is no session", () => {
      sessions.clear("u1", "bandcamp");
      expect(scanner.start("u1", "bandcamp", false)).toEqual({ conflict: "session_required" });
    });

    it("keeps one active scan per collector and store, and only the latest scan", async () => {
      let release!: () => void;
      searchReleases.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve([]))));
      scanner.start("u1", "bandcamp", false);

      expect(scanner.start("u1", "bandcamp", false)).toEqual({ conflict: "scan_active" });
      release();
      await untilStatus("done");

      db.update(digitalMatches).set({ checkedAt: new Date("2020-01-01") }).run();
      expect(scanner.start("u1", "bandcamp", true)).toMatchObject({ scan: { status: "running", recheck: true } });
      await untilStatus("done");
    });
  });

  describe("a session the store refuses", () => {
    it("stops as needs-session with its progress and resumes without checking finished items again", async () => {
      searchReleases.mockImplementation(async (session, query) => {
        if (query.includes("Two") && sessions.get("u1", "bandcamp") === SESSION && searchReleases.mock.calls.length < 4) {
          throw new StoreSessionExpiredError();
        }
        return defaultSearchReleases(session, query);
      });
      scanner.start("u1", "bandcamp", false);
      await untilStatus("needs-session");

      expect(scan()).toMatchObject({ albumCount: 1, tracksCount: 0, currentReleaseId: null });
      expect(sessions.get("u1", "bandcamp")).toBeNull();
      const callsBefore = searchReleases.mock.calls.length;

      sessions.set("u1", "bandcamp", { headers: { cookie: "fresh=1" } });
      scanner.resume("u1", "bandcamp");
      await untilStatus("done");

      const searched = searchReleases.mock.calls.slice(callsBefore).map(([, query]) => query);
      expect(searched.some((query) => query.includes("One"))).toBe(false);
      expect(scan()).toMatchObject({ albumCount: 1, tracksCount: 1, noneCount: 1, total: 3 });
    });

    it("stops as needs-session when the curl has expired between items", async () => {
      searchReleases.mockImplementationOnce(async () => {
        sessions.clear("u1", "bandcamp");
        return [albumOf("One")];
      });
      scanner.start("u1", "bandcamp", false);
      await untilStatus("needs-session");
      expect(scan().albumCount).toBe(1);
    });

    it("does not resume without a new curl, or a scan that is not waiting for one", async () => {
      scanner.resume("u1", "bandcamp");
      expect(scanner.current("u1", "bandcamp")).toBeUndefined();

      searchReleases.mockImplementationOnce(async () => {
        throw new StoreSessionExpiredError();
      });
      scanner.start("u1", "bandcamp", false);
      await untilStatus("needs-session");
      scanner.resume("u1", "bandcamp");
      expect(scan().status).toBe("needs-session");
    });

    it("waits for a curl after a restart", () => {
      // The first search never answers, as when the server stops in the middle of it.
      searchReleases.mockImplementationOnce(() => new Promise(() => undefined));
      scanner.start("u1", "bandcamp", false);
      settleScansAfterRestart(db);
      expect(scan().status).toBe("needs-session");
    });
  });

  describe("a store that errs", () => {
    it("pauses, then tries the same item again", async () => {
      let resume!: () => void;
      const scanner2 = new DigitalScanner(
        db,
        { stores: { bandcamp: { store: { id: "bandcamp", searchReleases, searchTracks }, lane: new PacedLane(0), host: "bandcamp.com" } }, sessions },
        (ms) => {
          sleeps.push(ms);
          return new Promise<void>((done) => (resume = done));
        },
      );
      searchReleases.mockRejectedValueOnce(new StoreUnavailableError("429"));
      scanner2.start("u1", "bandcamp", false);
      await vi.waitFor(() => expect(scanner2.current("u1", "bandcamp")!.status).toBe("paused"));

      expect(sleeps).toEqual([60_000]);
      expect(scanner2.current("u1", "bandcamp")!.pausedUntil).toBeInstanceOf(Date);

      resume();
      await vi.waitFor(() => expect(scanner2.current("u1", "bandcamp")!.status).toBe("done"));
      expect(scanner2.current("u1", "bandcamp")).toMatchObject({ albumCount: 1, pausedUntil: null, total: 3 });
    });

    it("backs off 1, 2, 4, 8 then 10 minutes and a success starts the steps over", async () => {
      searchReleases
        .mockRejectedValueOnce(new StoreUnavailableError())
        .mockRejectedValueOnce(new StoreUnavailableError())
        .mockRejectedValueOnce(new StoreUnavailableError())
        .mockRejectedValueOnce(new StoreUnavailableError())
        .mockRejectedValueOnce(new StoreUnavailableError())
        .mockImplementationOnce(defaultSearchReleases)
        .mockRejectedValueOnce(new StoreUnavailableError());
      scanner.start("u1", "bandcamp", false);
      await untilStatus("done");

      expect(sleeps).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 60_000]);
    });

    it("ends in error after about an hour of failing", async () => {
      searchReleases.mockRejectedValue(new StoreUnavailableError("503"));
      scanner.start("u1", "bandcamp", false);
      await untilStatus("failed");

      const hour = sleeps.reduce((sum, ms) => sum + ms, 0) / 60_000;
      expect(hour).toBeGreaterThanOrEqual(60);
      expect(hour).toBeLessThan(70);
      expect(scan().errorMessage).toContain("503");
      expect(scan()).toMatchObject({ currentReleaseId: null, pausedUntil: null });
    });
  });

  describe("an item that fails", () => {
    it("is counted as failed and the scan moves on, and is not tried again on resume", async () => {
      searchReleases.mockImplementation(async (session, query) => {
        if (query.includes("Two")) throw new Error("parse error");
        return defaultSearchReleases(session, query);
      });
      scanner.start("u1", "bandcamp", false);
      await untilStatus("done");

      expect(scan()).toMatchObject({ albumCount: 1, noneCount: 1, failedReleaseIds: [2] });
      expect(scan().plannedDone).toBe(scan().requestsPlanned);

      // A resume after a refused session leaves it out too.
      db.update((await import("../db/schema")).digitalScans).set({ status: "needs-session" }).run();
      scanner.resume("u1", "bandcamp");
      await untilStatus("done");
      expect(scan().failedReleaseIds).toEqual([2]);
    });
  });

  describe("cancel", () => {
    it("stops the scan after the request in flight", async () => {
      let release!: () => void;
      searchReleases.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve([albumOf("One")]))));
      scanner.start("u1", "bandcamp", false);
      await vi.waitFor(() => expect(searchReleases).toHaveBeenCalledTimes(1));

      expect(scanner.cancel("u1", "bandcamp")).toMatchObject({ status: "cancelled" });
      release();
      await vi.waitFor(() => expect(scanner.start("u1", "bandcamp", false)).toMatchObject({ scan: { status: "running" } }));
      await untilStatus("done");
      expect(searchReleases.mock.calls.length).toBeGreaterThan(1);
    });

    it("has nothing to stop when no scan is active", async () => {
      expect(scanner.cancel("u1", "bandcamp")).toBeUndefined();
      scanner.start("u1", "bandcamp", false);
      await untilStatus("done");
      expect(scanner.cancel("u1", "bandcamp")).toBeUndefined();
    });
  });

  describe("an item a person checked meanwhile", () => {
    it("is counted without a request", async () => {
      let release!: () => void;
      searchReleases.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve([albumOf("One")]))));
      scanner.start("u1", "bandcamp", false);
      await vi.waitFor(() => expect(searchReleases).toHaveBeenCalledTimes(1));
      db.insert(digitalMatches)
        .values({ releaseId: 3, store: "bandcamp", status: "none", tracks: [], trackCount: 2, checkedAt: new Date() })
        .run();
      release();
      await untilStatus("done");

      expect(scan()).toMatchObject({ albumCount: 1, tracksCount: 1, noneCount: 1, total: 3 });
      expect(scan().requestsDone).toBe(1 + 3);
      expect(scan().requestsPlanned).toBe(3 + 3);
    });
  });
});
