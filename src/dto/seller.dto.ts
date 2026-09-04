import type { SellerIndexStatus, SellerInventoryStatus } from "../db/schema";

export interface IndexStartedDto {
  username: string;
  runId: string;
}

export interface SellerStatusDto {
  username: string;
  lastIndexedAt: string | null;
  lastIndexStatus: SellerIndexStatus;
  currentlyRunning: boolean;
  totalReleasesFound: number;
  releasesEnriched: number;
  releasesFailed: number;
}

export interface SellerInventoryItemDto {
  releaseId: number;
  title: string;
  thumb: string | null;
  year: number | null;
  status: SellerInventoryStatus;
  firstSeenAt: string;
  soldAt: string | null;
}

export interface SellerInventoryPageDto {
  items: SellerInventoryItemDto[];
  page: number;
  pageSize: number;
  total: number;
}
