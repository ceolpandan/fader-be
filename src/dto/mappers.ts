import type { releases } from "../db/schema";
import type { DiscogsMaster } from "../types/discogs-api";
import type { MasterDetailDto } from "./master-detail.dto";
import type { ReleaseDetailDto } from "./release-detail.dto";

export function mapReleaseRowToDto(row: typeof releases.$inferSelect): ReleaseDetailDto {
  return {
    id: row.id,
    title: row.title,
    ...(row.thumb ? { thumb: row.thumb } : {}),
    year: row.year,
    genres: row.genres,
    styles: row.styles,
    artists: row.artists,
    tracklist: row.tracklist,
    videos: row.videos,
  };
}

export function mapMasterToDto(raw: DiscogsMaster): MasterDetailDto {
  return { ...raw };
}
