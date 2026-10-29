import type { digitalMatches } from "../db/schema";
import type { DigitalMatchDto } from "../dto/digital.dto";
import type { DigitalStoreId } from "./types";

type DigitalMatchRow = typeof digitalMatches.$inferSelect;

export function toDigitalMatchDto(row: DigitalMatchRow): DigitalMatchDto {
  return {
    store: row.store as DigitalStoreId,
    status: row.status,
    url: row.url,
    tracks: row.tracks,
    trackCount: row.trackCount,
    checkedAt: row.checkedAt.toISOString(),
  };
}
