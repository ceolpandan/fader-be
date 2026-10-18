import { releases } from "../db/schema";
import type { DiscogsRelease } from "../types/discogs-api";

/** What an enrichment fetch stores for a release: the Discogs fields we keep, plus the community rating, haves and wants. */
export function mapDiscogsReleaseToRow(raw: DiscogsRelease, enrichedAt: Date): typeof releases.$inferInsert {
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
    labels: (raw.labels ?? []).map((label) => ({
      id: label.id,
      name: label.name,
      ...(label.catno ? { catno: label.catno } : {}),
    })),
    artists: raw.artists.map((artist) => ({ id: artist.id, name: artist.name })),
    tracklist: (raw.tracklist ?? []).map((track) => ({
      position: track.position,
      title: track.title,
      ...(track.duration ? { duration: track.duration } : {}),
    })),
    videos: (raw.videos ?? []).map((video) => ({
      src: video.uri,
      ...(video.title ? { title: video.title } : {}),
      ...(video.duration !== undefined ? { duration: video.duration } : {}),
    })),
    ratingAverage: raw.community?.rating?.average ?? null,
    ratingCount: raw.community?.rating?.count ?? null,
    haveCount: raw.community?.have ?? null,
    wantCount: raw.community?.want ?? null,
    numForSale: raw.num_for_sale ?? null,
    numForSaleAt: enrichedAt,
    lowestPrice: raw.lowest_price ?? null,
    // Discogs sends "" for a release with no cover.
    thumb: raw.thumb || null,
    enrichedAt,
    missingAt: null,
  };
}
