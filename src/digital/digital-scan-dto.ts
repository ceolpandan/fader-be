import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { releases } from "../db/schema";
import type { DigitalScanDto } from "../dto/digital.dto";
import type { DigitalScanRow } from "./digital-scan";
import type { DigitalStoreId } from "./types";

/**
 * The scan as the API shows it. The requests left are estimated: the most the unchecked items
 * could take (the album search plus every track), scaled by how many requests the checked ones
 * needed against that most, since an album found early ends an item's searches.
 */
export function toDigitalScanDto(db: Db, scan: DigitalScanRow, gapMs: number, now = Date.now()): DigitalScanDto {
  const checked = scan.albumCount + scan.tracksCount + scan.noneCount;
  const ended = scan.status === "done" || scan.status === "cancelled" || scan.status === "failed";
  const ratio = scan.plannedDone > 0 ? Math.min(1, scan.requestsDone / scan.plannedDone) : 1;
  const requestsRemaining = ended ? 0 : Math.max(0, Math.ceil((scan.requestsPlanned - scan.plannedDone) * ratio));
  const pauseMs = scan.pausedUntil ? Math.max(0, scan.pausedUntil.getTime() - now) : 0;
  const counting = scan.status === "running" || scan.status === "paused";

  const current = scan.currentReleaseId
    ? db
        .select({ releaseId: releases.id, title: releases.title, artists: releases.artists })
        .from(releases)
        .where(eq(releases.id, scan.currentReleaseId))
        .get()
    : undefined;

  return {
    store: scan.store as DigitalStoreId,
    status: scan.status,
    recheck: scan.recheck,
    total: scan.total,
    checked,
    album: scan.albumCount,
    tracks: scan.tracksCount,
    none: scan.noneCount,
    skipped: scan.skipped,
    failed: scan.failedReleaseIds.length,
    requestsDone: scan.requestsDone,
    requestsRemaining,
    etaSeconds: counting ? Math.ceil((requestsRemaining * gapMs + pauseMs) / 1000) : null,
    current: current ?? null,
    pausedUntil: scan.pausedUntil?.toISOString() ?? null,
    errorMessage: scan.errorMessage,
    startedAt: scan.startedAt.toISOString(),
    finishedAt: scan.finishedAt?.toISOString() ?? null,
  };
}
