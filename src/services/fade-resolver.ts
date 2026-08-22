import { getAllMasterVersionReleaseIds, getRelease } from "../discogs-client";
import type { FadeResponseDto } from "../dto/fade.dto";

export async function resolveFadeFromRelease(releaseId: number): Promise<FadeResponseDto> {
  const release = await getRelease(releaseId);

  if (!release.master_id) {
    return { releaseId, releaseIds: [releaseId] };
  }

  const releaseIds = await getAllMasterVersionReleaseIds(release.master_id);
  if (!releaseIds.includes(releaseId)) {
    releaseIds.push(releaseId);
  }

  return { releaseId, masterId: release.master_id, releaseIds };
}

export async function resolveFadeFromMaster(masterId: number): Promise<FadeResponseDto> {
  const releaseIds = await getAllMasterVersionReleaseIds(masterId);
  return { masterId, releaseIds };
}
