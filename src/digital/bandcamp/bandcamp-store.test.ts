import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StoreSessionExpiredError, StoreUnavailableError } from "../types";
import { createBandcampStore } from "./bandcamp-store";

const session = { headers: { cookie: "a=1", "user-agent": "test" } };
const results = fs.readFileSync(path.join(__dirname, "fixtures", "search-albums.html"), "utf8");

const page = (body: string, status = 200) => vi.fn(async () => new Response(body, { status }));

describe("createBandcampStore", () => {
  it("searches albums with the session's headers", async () => {
    const fetchPage = page(results);
    const hits = await createBandcampStore(fetchPage).searchReleases!(session, "vc-118a permutation");

    expect(hits[0]).toMatchObject({ kind: "album", title: "Permutation", artist: "VC-118A" });
    const [url, init] = fetchPage.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://bandcamp.com/search?q=vc-118a%20permutation&item_type=a");
    expect(init.headers).toMatchObject({ cookie: "a=1", "user-agent": "test", "sec-fetch-site": "none" });
  });

  it("searches tracks with item_type=t", async () => {
    const fetchPage = page(results);
    await createBandcampStore(fetchPage).searchTracks!(session, "x");
    expect((fetchPage.mock.calls[0] as unknown as [string])[0]).toContain("item_type=t");
  });

  it("takes a client challenge for an expired session, even with a 200", async () => {
    const store = createBandcampStore(page("<html><head><title>Client Challenge</title></head></html>"));
    await expect(store.searchReleases!(session, "x")).rejects.toBeInstanceOf(StoreSessionExpiredError);
  });

  it("takes a 403 for an expired session", async () => {
    await expect(createBandcampStore(page("no", 403)).searchReleases!(session, "x")).rejects.toBeInstanceOf(
      StoreSessionExpiredError,
    );
  });

  it("takes a 429 or a 5xx for an unavailable store", async () => {
    for (const status of [429, 503]) {
      await expect(createBandcampStore(page("", status)).searchReleases!(session, "x")).rejects.toBeInstanceOf(
        StoreUnavailableError,
      );
    }
  });

  it("takes a network error for an unavailable store", async () => {
    const store = createBandcampStore(vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(store.searchTracks!(session, "x")).rejects.toBeInstanceOf(StoreUnavailableError);
  });
});
