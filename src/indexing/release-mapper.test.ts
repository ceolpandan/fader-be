import { describe, expect, it } from "vitest";
import type { DiscogsRelease } from "../types/discogs-api";
import { mapDiscogsReleaseToRow } from "./release-mapper";

describe("mapDiscogsReleaseToRow", () => {
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
