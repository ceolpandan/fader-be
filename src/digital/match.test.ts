import { describe, expect, it } from "vitest";
import { artistsMatch, isVariousArtists, searchQuery, titlesMatch } from "./match";

const artists = (...names: string[]) => names.map((name, id) => ({ id, name }));

describe("titlesMatch", () => {
  it("ignores case, accents and punctuation", () => {
    expect(titlesMatch("Café del Mar!", "cafe del mar")).toBe(true);
  });

  it("treats a trailing (Original Mix) as optional on either side", () => {
    expect(titlesMatch("Permutation (Original Mix)", "Permutation")).toBe(true);
    expect(titlesMatch("Permutation", "Permutation [Original]")).toBe(true);
  });

  it("keeps any other parenthetical", () => {
    expect(titlesMatch("Permutation (Mohlao Reshape)", "Permutation")).toBe(false);
    expect(titlesMatch("Permutation (Mohlao Reshape)", "Permutation (Mohlao Reshape)")).toBe(true);
  });

  it("does not match different titles or empty ones", () => {
    expect(titlesMatch("Enter", "Glut")).toBe(false);
    expect(titlesMatch("!!!", "???")).toBe(false);
  });
});

describe("artistsMatch", () => {
  it("matches any of the release's artists, without the Discogs number", () => {
    expect(artistsMatch("VC-118A", artists("Someone", "VC-118A (2)"))).toBe(true);
  });

  it("reads feat., ft, & and a comma as the same join", () => {
    expect(artistsMatch("A feat. B", artists("A", "B"))).toBe(true);
    expect(artistsMatch("A, B", artists("A", "B"))).toBe(true);
    expect(artistsMatch("A & B", artists("A", "B"))).toBe(true);
    expect(artistsMatch("A and B", artists("A & B"))).toBe(true);
  });

  it("rejects an artist the release does not credit", () => {
    expect(artistsMatch("Somebody Else", artists("VC-118A"))).toBe(false);
    expect(artistsMatch("A and C", artists("A", "B"))).toBe(false);
  });

  it("rejects an empty artist", () => {
    expect(artistsMatch("", artists("A"))).toBe(false);
  });
});

describe("isVariousArtists", () => {
  it("is true for a compilation only", () => {
    expect(isVariousArtists(artists("Various"))).toBe(true);
    expect(isVariousArtists(artists("Various", "Someone"))).toBe(false);
    expect(isVariousArtists([])).toBe(false);
  });
});

describe("searchQuery", () => {
  it("joins the first artist and the title", () => {
    expect(searchQuery(artists("VC-118A (2)", "B"), "Permutation")).toBe("VC-118A (2) Permutation");
  });

  it("leaves out Various", () => {
    expect(searchQuery(artists("Various"), "Compilation")).toBe("Compilation");
  });
});
