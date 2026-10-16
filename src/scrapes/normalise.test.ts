import { describe, expect, it } from "vitest";
import { normalise, parseLines, splitLine } from "./normalise";

describe("normalise", () => {
  it("ignores case, accents and punctuation", () => {
    expect(normalise("Café  Del Mar!")).toBe("cafe del mar");
  });

  it("reads & as and and drops a leading The", () => {
    expect(normalise("The Chemical Brothers")).toBe("chemical brothers");
    expect(normalise("Orbital & Friends")).toBe(normalise("Orbital and Friends"));
  });

  it("drops a Discogs disambiguation number", () => {
    expect(normalise("Nina Kraviz (2)")).toBe("nina kraviz");
  });
});

describe("splitLine", () => {
  it("splits on the first dash so a title may hold more", () => {
    expect(splitLine("Artist - Title - Remix")).toEqual({ artist: "Artist", title: "Title - Remix" });
  });

  it("rejects a line without an artist and a title", () => {
    expect(splitLine("Just a title")).toBeNull();
    expect(splitLine(" - Title")).toBeNull();
    expect(splitLine("Artist - ")).toBeNull();
  });
});

describe("parseLines", () => {
  it("trims, drops blanks and keeps each line once", () => {
    expect(parseLines("A - B\r\n\r\n  A - B \nC - D\n")).toEqual(["A - B", "C - D"]);
  });
});
