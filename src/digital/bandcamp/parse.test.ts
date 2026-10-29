import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isChallengePage, parseSearchResults } from "./parse";

const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

describe("parseSearchResults", () => {
  it("reads albums with their artist and plain URL", () => {
    const hits = parseSearchResults(fixture("search-albums.html"));
    expect(hits[0]).toEqual({
      kind: "album",
      title: "Permutation",
      artist: "VC-118A",
      album: null,
      url: "https://chaindata.bandcamp.com/album/permutation",
    });
    expect(hits).toHaveLength(2);
  });

  it("reads tracks with the album they are on", () => {
    const hits = parseSearchResults(fixture("search-tracks.html"));
    expect(hits).toHaveLength(3);
    expect(hits[0]).toEqual({
      kind: "track",
      title: "Permutation (Mohlao Reshape)",
      artist: "VC-118A",
      album: "Permutation",
      url: "https://chaindata.bandcamp.com/track/permutation-mohlao-reshape",
    });
    expect(hits[1]?.url).toBe("https://frustratedfunk.bandcamp.com/track/permutation");
  });

  it("splits an album called 'Stand by Me' at the last 'by'", () => {
    const html = `<li class="searchresult"><div class="itemtype">TRACK</div><div class="heading"><a href="x">Song &amp; Dance</a></div>
      <div class="subhead">from Stand by Me by Some Artist</div><div class="itemurl"><a href="x">https://a.bandcamp.com/track/s</a></div></li>`;
    expect(parseSearchResults(html)).toEqual([
      { kind: "track", title: "Song & Dance", artist: "Some Artist", album: "Stand by Me", url: "https://a.bandcamp.com/track/s" },
    ]);
  });

  it("leaves out results that are not albums or tracks", () => {
    const html = `<li class="searchresult"><div class="itemtype">ARTIST</div><div class="heading"><a>X</a></div>
      <div class="subhead">by X</div><div class="itemurl"><a>https://x.bandcamp.com</a></div></li>`;
    expect(parseSearchResults(html)).toEqual([]);
  });
});

describe("isChallengePage", () => {
  it("recognises the bot check", () => {
    expect(isChallengePage("<html><head><title>Client Challenge</title></head></html>")).toBe(true);
  });

  it("does not take results for a challenge", () => {
    expect(isChallengePage(fixture("search-albums.html"))).toBe(false);
  });
});
