export type FadeAction = "fade";

export interface FadeRequestDto {
  releaseId: number;
  action?: FadeAction;
}

export interface FadeResponseDto {
  releaseId: number;
  masterId?: number;
  releaseIds: number[];
}
