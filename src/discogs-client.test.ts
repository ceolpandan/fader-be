import { describe, it, expect, vi, afterEach } from "vitest";
import { getRelease, DiscogsAuthError, DiscogsNotFoundError, DiscogsRateLimitError } from "./discogs-client";

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

    const result = await getRelease(732194);

    expect(fetchMock).toHaveBeenCalledWith("https://api.discogs.com/releases/732194", expect.any(Object));
    expect(result.title).toBe("Stockholm");
  });

  it("throws DiscogsNotFoundError on 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, {})),
    );

    await expect(getRelease(1)).rejects.toThrow(DiscogsNotFoundError);
  });

  it("throws DiscogsAuthError on 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { message: "You are not allowed to do this" })),
    );

    await expect(getRelease(1)).rejects.toThrow(DiscogsAuthError);
  });

  it("throws DiscogsRateLimitError on 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(429, {}, { "Retry-After": "30" })),
    );

    await expect(getRelease(1)).rejects.toThrow(DiscogsRateLimitError);
  });
});
