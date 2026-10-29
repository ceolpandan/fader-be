import { describe, expect, it } from "vitest";
import { dedupeVideos } from "./dedupe-videos";

describe("dedupeVideos", () => {
  it("keeps the first copy of each link, in order", () => {
    const a = { src: "https://www.youtube.com/watch?v=a", title: "A - Untitled", duration: 729 };
    const b = { src: "https://www.youtube.com/watch?v=b", title: "B - Untitled", duration: 818 };

    expect(dedupeVideos([a, b, { ...a }, { ...b }])).toEqual([a, b]);
  });

  it("keeps the first title when the copies differ", () => {
    const first = { src: "https://youtu.be/x", title: "first" };

    expect(dedupeVideos([first, { src: "https://youtu.be/x", title: "second" }])).toEqual([first]);
  });

  it("returns an empty list unchanged", () => {
    expect(dedupeVideos([])).toEqual([]);
  });
});
