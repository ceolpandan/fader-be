import { describe, expect, it } from "vitest";
import type { DiscogsRelease } from "../types/discogs-api";
import { mapDiscogsReleaseToRow } from "./release-mapper";

describe("mapDiscogsReleaseToRow", () => {
  const priced = (lowest_price?: number | null) =>
    ({ id: 1, title: "T", resource_url: "", artists: [], lowest_price }) as unknown as DiscogsRelease;

  it("stores the price with the currency it came in", () => {
    expect(mapDiscogsReleaseToRow(priced(12.5), new Date(), "EUR")).toMatchObject({
      lowestPrice: 12.5,
      lowestPriceCurrency: "EUR",
    });
    expect(mapDiscogsReleaseToRow(priced(0), new Date(), "EUR")).toMatchObject({
      lowestPrice: 0,
      lowestPriceCurrency: "EUR",
    });
  });

  it("stores no currency without a price, or when the currency is not known", () => {
    expect(mapDiscogsReleaseToRow(priced(null), new Date(), "EUR")).toMatchObject({
      lowestPrice: null,
      lowestPriceCurrency: null,
    });
    expect(mapDiscogsReleaseToRow(priced(undefined), new Date(), "EUR").lowestPriceCurrency).toBeNull();
    expect(mapDiscogsReleaseToRow(priced(12.5), new Date())).toMatchObject({
      lowestPrice: 12.5,
      lowestPriceCurrency: null,
    });
  });

  it("stores a link once when Discogs attaches it to every track", () => {
    const raw: DiscogsRelease = {
      id: 60772,
      title: "#2",
      resource_url: "https://api.discogs.com/releases/60772",
      artists: [],
      videos: [
        { uri: "https://www.youtube.com/watch?v=a", title: "A - Untitled", duration: 729 },
        { uri: "https://www.youtube.com/watch?v=b", title: "B - Untitled", duration: 818 },
        { uri: "https://www.youtube.com/watch?v=a", title: "A - Untitled", duration: 729 },
        { uri: "https://www.youtube.com/watch?v=b", title: "B - Untitled", duration: 818 },
      ],
    };

    expect(mapDiscogsReleaseToRow(raw, new Date()).videos).toEqual([
      { src: "https://www.youtube.com/watch?v=a", title: "A - Untitled", duration: 729 },
      { src: "https://www.youtube.com/watch?v=b", title: "B - Untitled", duration: 818 },
    ]);
  });
});
