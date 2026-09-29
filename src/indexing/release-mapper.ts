import { releases } from "../db/schema";
import type { DiscogsRelease } from "../types/discogs-api";

export function mapDiscogsReleaseToRow(raw: DiscogsRelease): typeof releases.$inferInsert {
  return {
    id: raw.id,
    title: raw.title,
    year: raw.year ?? null,
    country: raw.country ?? null,
    genres: raw.genres ?? [],
    styles: raw.styles ?? [],
    formats: (raw.formats ?? []).map((format) => ({
      name: format.name,
      descriptions: format.descriptions ?? [],
    })),
    masterId: raw.master_id ?? null,
    thumb: raw.thumb ?? null,
    ratingAverage: raw.community?.rating?.average ?? null,
    ratingCount: raw.community?.rating?.count ?? null,
    haves: raw.community?.have ?? null,
    wants: raw.community?.want ?? null,
    labelIds: (raw.labels ?? []).map((label) => label.id),
    artists: raw.artists.map((artist) => ({ id: artist.id, name: artist.name })),
    tracklist: (raw.tracklist ?? []).map((track) => ({
      position: track.position,
      title: track.title,
      ...(track.duration ? { duration: track.duration } : {}),
    })),
    videos: (raw.videos ?? []).map((video) => ({
      uri: video.uri,
      ...(video.title ? { title: video.title } : {}),
      ...(video.duration !== undefined ? { duration: video.duration } : {}),
    })),
  };
}
