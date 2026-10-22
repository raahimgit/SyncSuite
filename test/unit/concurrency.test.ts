import { describe, expect, it } from "vitest";
import { mapConcurrent } from "../../src/core/concurrency.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapConcurrent", () => {
  it("never exceeds the concurrency limit and preserves result order", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapConcurrent([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(5 * (9 - n));
      active -= 1;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
    expect(peak).toBe(3);
  });

  it("stops starting new items after a failure and waits for in-flight work", async () => {
    const started: number[] = [];
    let active = 0;
    await expect(
      mapConcurrent([0, 1, 2, 3, 4, 5], 2, async (n) => {
        started.push(n);
        active += 1;
        await sleep(n === 1 ? 1 : 20);
        active -= 1;
        if (n === 1) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
    expect(active).toBe(0);
    expect(started.length).toBeLessThan(6);
  });

  it("rejects with the abort reason when the signal is already aborted", async () => {
    const c = new AbortController();
    c.abort(new Error("stop"));
    await expect(mapConcurrent([1], 1, async (n) => n, c.signal)).rejects.toThrow("stop");
  });

  it("handles an empty input", async () => {
    expect(await mapConcurrent([], 4, async () => 1)).toEqual([]);
  });
});
