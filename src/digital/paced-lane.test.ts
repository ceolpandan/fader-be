import { describe, expect, it } from "vitest";
import { CHECK_PRIORITY, PacedLane } from "./paced-lane";

describe("PacedLane", () => {
  function clock() {
    let time = 0;
    const slept: number[] = [];
    return {
      now: () => time,
      sleep: async (ms: number) => {
        slept.push(ms);
        time += ms;
      },
      slept,
      advance: (ms: number) => (time += ms),
    };
  }

  it("starts tasks at least the gap apart, in order", async () => {
    const c = clock();
    const lane = new PacedLane(1200, c.now, c.sleep);
    const starts: number[] = [];
    await Promise.all([1, 2, 3].map(() => lane.run(async () => starts.push(c.now()))));
    expect(starts).toEqual([0, 1200, 2400]);
  });

  it("starts a higher priority task before the waiting ones, keeping the gap", async () => {
    const c = clock();
    const lane = new PacedLane(1200, c.now, c.sleep);
    const started: string[] = [];
    const task = (name: string) => async () => started.push(`${name}@${c.now()}`);
    await Promise.all([
      lane.run(task("running")),
      lane.run(task("scan 1")),
      lane.run(task("scan 2")),
      lane.run(task("check"), CHECK_PRIORITY),
    ]);
    expect(started).toEqual(["running@0", "check@1200", "scan 1@2400", "scan 2@3600"]);
  });

  it("does not wait when the gap has already passed", async () => {
    const c = clock();
    const lane = new PacedLane(1200, c.now, c.sleep);
    await lane.run(async () => undefined);
    c.advance(5000);
    await lane.run(async () => undefined);
    expect(c.slept).toEqual([]);
  });

  it("keeps going after a task fails", async () => {
    const c = clock();
    const lane = new PacedLane(1200, c.now, c.sleep);
    await expect(lane.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(lane.run(async () => "next")).resolves.toBe("next");
  });

  it("returns what the task returns", async () => {
    const lane = new PacedLane(0);
    await expect(lane.run(async () => 42)).resolves.toBe(42);
  });
});
