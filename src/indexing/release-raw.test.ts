import { describe, it, expect } from "vitest";
import type { DiscogsRelease } from "../types/discogs-api";
import { stripReleaseBody } from "./release-raw";

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
