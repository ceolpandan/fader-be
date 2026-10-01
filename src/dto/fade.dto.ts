import type { FadeKind } from "../db/schema";

/** Provide exactly one of releaseId or masterId. */
export interface FadeRequestDto {
  releaseId?: number;
  masterId?: number;
}

/** The stored fade: the master when the release has one, otherwise the release itself. */
export interface FadeResponseDto {
  kind: FadeKind;
  id: number;
}

export interface FadedIdsDto {
  masterIds: number[];
  releaseIds: number[];
}
