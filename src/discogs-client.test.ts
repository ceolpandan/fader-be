import { describe, it, expect, vi, afterEach } from "vitest";
import { getCollectionCount, getRelease, getWantlistCount, searchFirstReleaseId, DiscogsAuthError, DiscogsNotFoundError, DiscogsRateLimitError } from "./discogs-client";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("getRelease", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the release from Discogs", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 732194, title: "Stockholm" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getRelease(732194, "tok");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.discogs.com/releases/732194",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Discogs token=tok" }) }),
    );
    expect(result.title).toBe("Stockholm");
  });

  it("throws DiscogsNotFoundError on 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, {})),
    );

    await expect(getRelease(1, "tok")).rejects.toThrow(DiscogsNotFoundError);
  });

  it("throws DiscogsAuthError on 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { message: "You are not allowed to do this" })),
    );

    await expect(getRelease(1, "tok")).rejects.toThrow(DiscogsAuthError);
  });

  it("throws DiscogsRateLimitError on 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(429, {}, { "Retry-After": "30" })),
    );

    await expect(getRelease(1, "tok")).rejects.toThrow(DiscogsRateLimitError);
  });
});

describe("collection and wantlist counts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the copies in the All folder of the collection", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return jsonResponse(200, { id: 0, count: 120 });
      }),
    );

    expect(await getCollectionCount("dan dan", "tok")).toBe(120);

    expect(urls[0]).toBe("https://api.discogs.com/users/dan%20dan/collection/folders/0");
  });

  it("reads the wantlist size from the pagination of a one-item page", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return jsonResponse(200, { pagination: { items: 7 }, wants: [] });
      }),
    );

    expect(await getWantlistCount("dan dan", "tok")).toBe(7);

    expect(urls[0]).toBe("https://api.discogs.com/users/dan%20dan/wants?per_page=1");
  });

  it("throws DiscogsAuthError when Discogs refuses the token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, {})));

    await expect(getWantlistCount("dan", "tok")).rejects.toThrow(DiscogsAuthError);
  });
});

describe("searchFirstReleaseId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks Discogs for releases only and returns the id of the first result", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return jsonResponse(200, { results: [{ id: 42, type: "release" }, { id: 43, type: "release" }] });
      }),
    );

    expect(await searchFirstReleaseId("Takin' You High", "tok")).toBe(42);
    expect(urls[0]).toBe("https://api.discogs.com/database/search?type=release&per_page=1&q=Takin'%20You%20High");
  });

  it("is null when Discogs finds nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { results: [] })));

    expect(await searchFirstReleaseId("zzzz", "tok")).toBeNull();
  });
});
