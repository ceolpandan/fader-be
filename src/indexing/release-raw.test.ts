import { describe, it, expect } from "vitest";
import type { DiscogsRelease } from "../types/discogs-api";
import { loadReleaseFixture, RELEASE_FIXTURE_IDS } from "./__fixtures__/release-fixtures";
import { stripReleaseBody } from "./release-raw";

/** Every key path of a JSON value, array indexes included, mapped to its leaf value as JSON. */
function leafPaths(value: unknown, prefix = "", out = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(value) && value.length > 0) {
    value.forEach((item, index) => leafPaths(item, `${prefix}[${index}]`, out));
  } else if (value !== null && typeof value === "object" && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) leafPaths(child, prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.set(prefix, JSON.stringify(value));
  }
  return out;
}

/** The key names at every depth, as a flat list. */
function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => allKeys(item, out));
  else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      allKeys(child, out);
    }
  }
  return out;
}

describe("stripReleaseBody against real Discogs responses (fader-ui#153)", () => {
  describe.each(RELEASE_FIXTURE_IDS)("release %i", (id) => {
    const { raw, stripped } = loadReleaseFixture(id);
    const body = stripReleaseBody(raw);
    const result = JSON.parse(body) as Record<string, unknown>;

    it("equals the reviewed .stripped.json", () => {
      expect(result).toEqual(stripped);
    });

    it("holds no resource_url key at any depth and no top-level images or master_url", () => {
      expect(allKeys(result)).not.toContain("resource_url");
      expect(result).not.toHaveProperty("images");
      expect(result).not.toHaveProperty("master_url");
    });

    it("loses exactly images, master_url and the resource_url paths, and changes no value", () => {
      const before = leafPaths(raw);
      const after = leafPaths(result);

      for (const [key, value] of after) expect(before.get(key), key).toBe(value);

      const removed = [...before.keys()].filter((key) => !after.has(key));
      expect(removed.length).toBeGreaterThan(0);
      for (const key of removed) {
        expect(key === "master_url" || key.startsWith("images[") || /(^|\.)resource_url$/.test(key), key).toBe(true);
      }
      // Every resource_url the response had is gone, not just some.
      expect([...before.keys()].filter((key) => /(^|\.)resource_url$/.test(key) && after.has(key))).toEqual([]);
    });

    it("is valid JSON that parses to the stripped object", () => {
      expect(typeof body).toBe("string");
      expect(() => JSON.parse(body)).not.toThrow();
      expect(JSON.parse(body)).toEqual(stripped);
    });
  });

  it("keeps the fields a filter may need, from a response that has them all (4000)", () => {
    const { raw } = loadReleaseFixture(4000);
    const result = JSON.parse(stripReleaseBody(raw)) as {
      notes: string;
      uri: string;
      thumb: string;
      identifiers: unknown[];
      companies: unknown[];
      extraartists: unknown[];
      tracklist: { extraartists?: unknown[] }[];
      community: { contributors: Record<string, unknown>[]; submitter: Record<string, unknown> };
    };

    expect(result.notes).toBe(raw.notes);
    expect(result.uri).toBe(raw.uri);
    expect(result.thumb).toBe(raw.thumb);
    expect(result.identifiers).toHaveLength(raw.identifiers!.length);
    expect(result.companies).toHaveLength(raw.companies!.length);
    expect(result.extraartists).toHaveLength(raw.extraartists!.length);
    expect(result.tracklist.some((track) => (track.extraartists ?? []).length > 0)).toBe(true);
    expect(result.community.contributors.length).toBeGreaterThan(0);
    for (const contributor of result.community.contributors) expect(Object.keys(contributor)).toEqual(["username"]);
  });

  it("keeps a white label promo's and a limited edition's format descriptions", () => {
    const whiteLabel = JSON.parse(stripReleaseBody(loadReleaseFixture(1894284).raw)) as DiscogsRelease;
    const limited = JSON.parse(stripReleaseBody(loadReleaseFixture(1096326).raw)) as DiscogsRelease;

    expect(whiteLabel.formats?.[0]?.descriptions).toEqual(expect.arrayContaining(["White Label", "Promo", '12"']));
    expect(limited.formats?.[0]?.descriptions).toEqual(expect.arrayContaining(["Limited Edition", '12"']));
  });

  it("removes resource_url nested several levels deep and keeps values and keys that merely mention it", () => {
    const synthetic = {
      id: 1,
      title: "T",
      resource_url: "gone",
      notes: "the resource_url field is dropped",
      resource_url_note: "a different key",
      nested: {
        resource_url: "gone",
        keep: "me",
        deeper: [
          { resource_url: "gone", label: "resource_url" },
          [{ resource_url: "gone", inner: { resource_url: "gone", ok: true, list: [{ resource_url: "gone", n: 1 }] } }],
        ],
      },
    } as unknown as DiscogsRelease;

    expect(JSON.parse(stripReleaseBody(synthetic))).toEqual({
      id: 1,
      title: "T",
      notes: "the resource_url field is dropped",
      resource_url_note: "a different key",
      nested: {
        keep: "me",
        deeper: [{ label: "resource_url" }, [{ inner: { ok: true, list: [{ n: 1 }] } }]],
      },
    });
  });
});

describe("stripReleaseBody", () => {
  const release = {
    id: 1,
    title: "T",
    resource_url: "https://api.discogs.com/releases/1",
    master_url: "https://api.discogs.com/masters/2",
    master_id: 2,
    uri: "https://www.discogs.com/release/1",
    thumb: "https://i.discogs.com/t.jpg",
    notes: "Pressed in 1999.",
    date_changed: "2024-02-19T02:39:32-08:00",
    images: [
      {
        type: "primary",
        uri: "https://i.discogs.com/a.jpg",
        resource_url: "https://i.discogs.com/a.jpg",
      },
    ],
    artists: [
      {
        id: 7,
        name: "Band",
        resource_url: "https://api.discogs.com/artists/7",
      },
    ],
    tracklist: [
      {
        position: "A1",
        title: "One",
        extraartists: [
          {
            id: 8,
            name: "Mixer",
            resource_url: "https://api.discogs.com/artists/8",
          },
        ],
      },
    ],
    community: {
      have: 3,
      submitter: {
        username: "sub",
        resource_url: "https://api.discogs.com/users/sub",
      },
      contributors: [{ username: "con", resource_url: "https://api.discogs.com/users/con" }],
    },
  } as unknown as DiscogsRelease;

  const stripped = () => JSON.parse(stripReleaseBody(release)) as Record<string, unknown>;

  it("drops the top-level images and master_url", () => {
    expect(stripped()).not.toHaveProperty("images");
    expect(stripped()).not.toHaveProperty("master_url");
  });

  it("drops resource_url at every depth", () => {
    expect(stripReleaseBody(release)).not.toContain("resource_url");
  });

  it("keeps everything else, including notes, contributors, uri and thumb", () => {
    expect(stripped()).toEqual({
      id: 1,
      title: "T",
      master_id: 2,
      uri: "https://www.discogs.com/release/1",
      thumb: "https://i.discogs.com/t.jpg",
      notes: "Pressed in 1999.",
      date_changed: "2024-02-19T02:39:32-08:00",
      artists: [{ id: 7, name: "Band" }],
      tracklist: [
        {
          position: "A1",
          title: "One",
          extraartists: [{ id: 8, name: "Mixer" }],
        },
      ],
      community: {
        have: 3,
        submitter: { username: "sub" },
        contributors: [{ username: "con" }],
      },
    });
  });

  it("keeps an images key nested below the top level", () => {
    const nested = {
      id: 1,
      title: "T",
      extra: { images: [1] },
    } as unknown as DiscogsRelease;
    expect(JSON.parse(stripReleaseBody(nested))).toHaveProperty("extra.images");
  });
});
