import { describe, expect, it, vi } from "vitest";
import { checkRelease, type CheckableRelease } from "./check-release";
import { PacedLane } from "./paced-lane";
import { StoreSessionExpiredError, type DigitalStore, type StoreHit } from "./types";

const session = { headers: {} };
const lane = () => new PacedLane(0);

const album = (title: string, artist: string, url = "https://a.bandcamp.com/album/x"): StoreHit => ({
  kind: "album",
  title,
  artist,
  album: null,
  url,
});
const track = (title: string, artist: string, albumTitle: string | null, url: string): StoreHit => ({
  kind: "track",
  title,
  artist,
  album: albumTitle,
  url,
});

const release: CheckableRelease = {
  id: 1,
  title: "Permutation",
  artists: [{ id: 1, name: "VC-118A" }],
  tracklist: [
    { position: "A1", title: "Enter" },
    { position: "A2", title: "Glut" },
    { position: "", title: "Side B" },
    { position: "B1", title: "Sequence" },
  ],
};

function storeOf(albums: Record<string, StoreHit[]>, tracks: Record<string, StoreHit[]>) {
  const searchReleases = vi.fn(async (_s, q: string) => albums[q] ?? []);
  const searchTracks = vi.fn(async (_s, q: string) => tracks[q] ?? []);
  const store: DigitalStore = { id: "bandcamp", searchReleases, searchTracks };
  return { store, searchReleases, searchTracks };
}

describe("checkRelease", () => {
  it("finds the album and does not search the tracks", async () => {
    const { store, searchTracks } = storeOf(
      { "VC-118A Permutation": [album("Permutation", "VC-118A", "https://chaindata.bandcamp.com/album/permutation")] },
      {},
    );
    const result = await checkRelease(store, lane(), session, release);
    expect(result).toEqual({
      status: "album",
      url: "https://chaindata.bandcamp.com/album/permutation",
      tracks: [],
      trackCount: null,
    });
    expect(searchTracks).not.toHaveBeenCalled();
  });

  it("rejects an album by another artist", async () => {
    const { store } = storeOf({ "VC-118A Permutation": [album("Permutation", "Somebody Else")] }, {});
    expect((await checkRelease(store, lane(), session, release)).status).toBe("none");
  });

  it("falls back to the tracks and keeps only the ones found, skipping headings", async () => {
    const { store, searchTracks } = storeOf(
      {},
      {
        "VC-118A Enter": [track("Enter", "VC-118A", "Permutation", "https://a.bandcamp.com/track/enter")],
        "VC-118A Sequence": [
          track("Sequence (Original Mix)", "VC-118A", "Permutation", "https://a.bandcamp.com/track/sequence"),
        ],
      },
    );
    const result = await checkRelease(store, lane(), session, release);
    expect(result).toEqual({
      status: "tracks",
      url: null,
      tracks: [
        { position: "A1", title: "Enter", url: "https://a.bandcamp.com/track/enter" },
        { position: "B1", title: "Sequence", url: "https://a.bandcamp.com/track/sequence" },
      ],
      trackCount: 3,
    });
    expect(searchTracks).toHaveBeenCalledTimes(3);
  });

  it("is none when neither the album nor any track is found", async () => {
    const { store } = storeOf({}, {});
    expect(await checkRelease(store, lane(), session, release)).toEqual({
      status: "none",
      url: null,
      tracks: [],
      trackCount: 3,
    });
  });

  it("skips the album search for a compilation and takes a track on an album of the same title", async () => {
    const compilation: CheckableRelease = {
      id: 2,
      title: "Best of Techno",
      artists: [{ id: 194, name: "Various" }],
      tracklist: [{ position: "1", title: "Intro" }],
    };
    const { store, searchReleases } = storeOf(
      {},
      {
        "Best of Techno Intro": [
          track("Intro", "Other", "Another Album", "https://a.bandcamp.com/track/wrong"),
          track("Intro", "Anyone", "Best of Techno", "https://a.bandcamp.com/track/intro"),
        ],
      },
    );
    const result = await checkRelease(store, lane(), session, compilation);
    expect(searchReleases).not.toHaveBeenCalled();
    expect(result.tracks).toEqual([{ position: "1", title: "Intro", url: "https://a.bandcamp.com/track/intro" }]);
  });

  it("uses only the searches a store declares", async () => {
    const searchTracks = vi.fn(async () => [track("Enter", "VC-118A", null, "https://a.bandcamp.com/track/enter")]);
    const store: DigitalStore = { id: "bandcamp", searchTracks };
    const result = await checkRelease(store, lane(), session, release);
    expect(result.status).toBe("tracks");
  });

  it("sends every request through the lane", async () => {
    const run = vi.fn(<T,>(task: () => Promise<T>) => task());
    const fakeLane = { run } as unknown as PacedLane;
    const { store } = storeOf({}, {});
    await checkRelease(store, fakeLane, session, release);
    // one album search and one search for each of the three tracks
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("passes on a session the store refused", async () => {
    const store: DigitalStore = {
      id: "bandcamp",
      searchReleases: async () => {
        throw new StoreSessionExpiredError();
      },
    };
    await expect(checkRelease(store, lane(), session, release)).rejects.toBeInstanceOf(StoreSessionExpiredError);
  });
});
