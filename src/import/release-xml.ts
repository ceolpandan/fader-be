import { SaxesParser } from "saxes";
import type { releases, ReleaseArtistStub, ReleaseFormat, ReleaseLabel, ReleaseTrack, ReleaseVideo } from "../db/schema";

/** What one `<release>` of the Discogs releases dump holds that Fader keeps. */
export interface DumpRelease {
  id: number;
  title: string;
  released: string | undefined;
  country: string | undefined;
  /** `0` when the release has no master. */
  masterId: number;
  genres: string[];
  styles: string[];
  formats: ReleaseFormat[];
  labels: ReleaseLabel[];
  artists: ReleaseArtistStub[];
  tracklist: ReleaseTrack[];
  videos: ReleaseVideo[];
}

export interface ReleaseParser {
  write(xml: string): void;
  close(): void;
}

const R = "releases/release";

/**
 * Streams `<release>` elements out of the dump: feed it text in any size of piece. Everything not
 * kept (extra artists, notes, identifiers, companies, video descriptions, per-track artists) is
 * skipped as it goes by. The text must sit inside a `<releases>` root.
 */
export function createReleaseParser(onRelease: (release: DumpRelease) => void): ReleaseParser {
  const parser = new SaxesParser();
  const stack: string[] = [];
  let release: DumpRelease | null = null;
  let leaf: { path: string; text: string } | null = null;
  let artist: ReleaseArtistStub | null = null;
  let format: ReleaseFormat | null = null;
  let track: ReleaseTrack | null = null;
  let video: ReleaseVideo | null = null;

  parser.on("opentag", (tag) => {
    stack.push(tag.name);
    const path = stack.join("/");
    const attrs = tag.attributes as Record<string, string>;
    leaf = null;
    switch (path) {
      case R:
        release = {
          id: Number(attrs.id),
          title: "",
          released: undefined,
          country: undefined,
          masterId: 0,
          genres: [],
          styles: [],
          formats: [],
          labels: [],
          artists: [],
          tracklist: [],
          videos: [],
        };
        break;
      case `${R}/artists/artist`:
        artist = { id: 0, name: "" };
        break;
      case `${R}/labels/label`:
        release!.labels.push({
          id: Number(attrs.id),
          name: attrs.name ?? "",
          ...(attrs.catno ? { catno: attrs.catno } : {}),
        });
        break;
      case `${R}/formats/format`:
        format = { name: attrs.name ?? "", descriptions: [] };
        break;
      case `${R}/tracklist/track`:
        track = { position: "", title: "" };
        break;
      case `${R}/videos/video`:
        video = { src: attrs.src ?? "" };
        if (attrs.duration) video.duration = Number(attrs.duration);
        break;
      case `${R}/artists/artist/id`:
      case `${R}/artists/artist/name`:
      case `${R}/title`:
      case `${R}/genres/genre`:
      case `${R}/styles/style`:
      case `${R}/country`:
      case `${R}/released`:
      case `${R}/master_id`:
      case `${R}/formats/format/descriptions/description`:
      case `${R}/tracklist/track/position`:
      case `${R}/tracklist/track/title`:
      case `${R}/tracklist/track/duration`:
      case `${R}/videos/video/title`:
        leaf = { path, text: "" };
        break;
    }
  });

  parser.on("text", (text) => {
    if (leaf) leaf.text += text;
  });

  parser.on("closetag", () => {
    const path = stack.join("/");
    if (leaf && leaf.path === path) {
      const text = leaf.text;
      switch (path) {
        case `${R}/artists/artist/id`: artist!.id = Number(text); break;
        case `${R}/artists/artist/name`: artist!.name = text; break;
        case `${R}/title`: release!.title = text; break;
        case `${R}/genres/genre`: release!.genres.push(text); break;
        case `${R}/styles/style`: release!.styles.push(text); break;
        case `${R}/country`: release!.country = text; break;
        case `${R}/released`: release!.released = text; break;
        case `${R}/master_id`: release!.masterId = Number(text) || 0; break;
        case `${R}/formats/format/descriptions/description`: format!.descriptions.push(text); break;
        case `${R}/tracklist/track/position`: track!.position = text; break;
        case `${R}/tracklist/track/title`: track!.title = text; break;
        case `${R}/tracklist/track/duration`: if (text) track!.duration = text; break;
        case `${R}/videos/video/title`: if (text) video!.title = text; break;
      }
      leaf = null;
    }
    switch (path) {
      case `${R}/artists/artist`: release!.artists.push(artist!); break;
      case `${R}/formats/format`: release!.formats.push(format!); break;
      case `${R}/tracklist/track`: release!.tracklist.push(track!); break;
      case `${R}/videos/video`: release!.videos.push(video!); break;
      case R:
        onRelease(release!);
        release = null;
        break;
    }
    stack.pop();
  });

  parser.on("error", (error) => {
    throw error;
  });

  return {
    write: (xml) => void parser.write(xml),
    close: () => void parser.close(),
  };
}

/** The `releases` table row for a dump release. `0` and malformed values become null. */
export function toReleaseRow(r: DumpRelease): typeof releases.$inferInsert {
  const year = /^\d{4}/.test(r.released ?? "") ? Number(r.released!.slice(0, 4)) : 0;
  return {
    id: r.id,
    title: r.title,
    year: year > 0 ? year : null,
    country: r.country ?? null,
    genres: r.genres,
    styles: r.styles,
    formats: r.formats,
    masterId: r.masterId > 0 ? r.masterId : null,
    labels: r.labels,
    artists: r.artists,
    tracklist: r.tracklist,
    videos: r.videos,
  };
}
