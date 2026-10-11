import { describe, it, expect, vi, afterEach } from "vitest";
import { getDiscogsProfile, getRelease, DiscogsAuthError, DiscogsNotFoundError, DiscogsRateLimitError } from "./discogs-client";

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

describe("getDiscogsProfile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the username, then the collection and wantlist counts", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/oauth/identity")) return jsonResponse(200, { id: 1, username: "dan dan" });
      if (url.includes("/collection/folders/0")) return jsonResponse(200, { id: 0, count: 120 });
      return jsonResponse(200, { pagination: { items: 7 }, wants: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const profile = await getDiscogsProfile("tok");

    expect(profile).toEqual({ username: "dan dan", collectionCount: 120, wantlistCount: 7 });
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toContain("https://api.discogs.com/users/dan%20dan/collection/folders/0");
    expect(urls).toContain("https://api.discogs.com/users/dan%20dan/wants?per_page=1");
  });

  it("fails as a whole when one of the counts fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/oauth/identity")
          ? jsonResponse(200, { id: 1, username: "dan" })
          : jsonResponse(403, {}),
      ),
    );

    await expect(getDiscogsProfile("tok")).rejects.toThrow(DiscogsAuthError);
  });
});
