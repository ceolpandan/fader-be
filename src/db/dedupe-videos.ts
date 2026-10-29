import type { ReleaseVideo } from "./schema";

/**
 * A release's videos as a set: Discogs lists the same link once per track it is attached to, so a
 * two-track release can arrive with every link twice. The first copy of a link (by exact `src`) is kept.
 */
export function dedupeVideos(videos: ReleaseVideo[]): ReleaseVideo[] {
  const seen = new Set<string>();
  return videos.filter(({ src }) => {
    if (seen.has(src)) return false;
    seen.add(src);
    return true;
  });
}
