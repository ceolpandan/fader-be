import type { DiscogsMaster, DiscogsRelease } from "../types/discogs-api";
import type { MasterDetailDto } from "./master-detail.dto";
import type { ReleaseDetailDto } from "./release-detail.dto";

export function mapReleaseToDto(raw: DiscogsRelease): ReleaseDetailDto {
  return { ...raw };
}

export function mapMasterToDto(raw: DiscogsMaster): MasterDetailDto {
  return { ...raw };
}
