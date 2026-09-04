import { describe, it, expect, vi, afterEach } from "vitest";
import { getInventory, DiscogsNotFoundError } from "./discogs-client";
import type { DiscogsInventoryPage } from "./types/discogs-api";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("getInventory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches a page with per_page=100 and returns the typed pagination + listings", async () => {
    const fixture: DiscogsInventoryPage = {
      pagination: {
        page: 1,
        pages: 2,
        per_page: 100,
        items: 150,
        urls: { next: "https://api.discogs.com/users/some-seller/inventory?page=2" },
      },
      listings: [
        {
          id: 111,
          status: "For Sale",
          price: { currency: "USD", value: 20 },
          condition: "Mint (M)",
          seller: { username: "some-seller", resource_url: "https://api.discogs.com/users/some-seller", id: 1 },
          release: {
            id: 732194,
            resource_url: "https://api.discogs.com/releases/732194",
            catalog_number: "SVEK001",
            year: 1998,
            description: "The Persuader - Stockholm",
          },
          resource_url: "https://api.discogs.com/marketplace/listings/111",
        },
      ],
    };

    const fetchMock = vi.fn(async () => jsonResponse(200, fixture));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getInventory("some-seller", 1);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.discogs.com/users/some-seller/inventory?page=1&per_page=100",
      expect.any(Object),
    );
    expect(result.pagination.pages).toBe(2);
    expect(result.listings[0]!.release.id).toBe(732194);
  });

  it("throws DiscogsNotFoundError on 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, {})),
    );

    await expect(getInventory("unknown-user", 1)).rejects.toThrow(DiscogsNotFoundError);
  });
});
