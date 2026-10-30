import { describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import type { DigitalScanRow } from "./digital-scan";
import { toDigitalScanDto } from "./digital-scan-dto";

const db = {} as Db;

function scan(overrides: Partial<DigitalScanRow> = {}): DigitalScanRow {
  return {
    uid: "u1",
    store: "bandcamp",
    recheck: false,
    status: "running",
    total: 10,
    skipped: 0,
    albumCount: 0,
    tracksCount: 0,
    noneCount: 0,
    failedReleaseIds: [],
    requestsDone: 0,
    requestsPlanned: 100,
    plannedDone: 0,
    currentReleaseId: null,
    pausedUntil: null,
    errorMessage: null,
    startedAt: new Date("2026-10-29T10:00:00Z"),
    finishedAt: null,
    ...overrides,
  };
}

describe("toDigitalScanDto", () => {
  it("expects the worst case until an item has been checked", () => {
    const dto = toDigitalScanDto(db, scan(), 1200);
    expect(dto.requestsRemaining).toBe(100);
    expect(dto.etaSeconds).toBe(120);
  });

  it("scales the requests left by how many the checked items really took", () => {
    // Items worth 40 requests at most took 10 (albums found at once), so 60 more planned means about 15.
    const dto = toDigitalScanDto(db, scan({ requestsDone: 10, plannedDone: 40, albumCount: 3, noneCount: 1 }), 1000);
    expect(dto).toMatchObject({ checked: 4, requestsDone: 10, requestsRemaining: 15, etaSeconds: 15 });
  });

  it("counts the pause in the time left", () => {
    const now = Date.parse("2026-10-29T10:05:00Z");
    const dto = toDigitalScanDto(
      db,
      scan({ status: "paused", pausedUntil: new Date("2026-10-29T10:06:00Z"), requestsPlanned: 10 }),
      1000,
      now,
    );
    expect(dto).toMatchObject({ requestsRemaining: 10, etaSeconds: 70, pausedUntil: "2026-10-29T10:06:00.000Z" });
  });

  it("has no time left once the scan has ended or waits for a curl", () => {
    expect(toDigitalScanDto(db, scan({ status: "done", finishedAt: new Date() }), 1200)).toMatchObject({
      requestsRemaining: 0,
      etaSeconds: null,
    });
    expect(toDigitalScanDto(db, scan({ status: "needs-session" }), 1200).etaSeconds).toBeNull();
  });

  it("counts the failed items", () => {
    expect(toDigitalScanDto(db, scan({ failedReleaseIds: [4, 9] }), 1200).failed).toBe(2);
  });
});
