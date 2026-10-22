import { describe, expect, it, vi } from "vitest";
import { SyncError } from "../../src/core/types.js";
import type { Clock } from "../../src/core/types.js";
import { computeBackoffDelay, computeRetryDelay, executeWithRetry } from "../../src/core/retry.js";
import type { RetryPolicy } from "../../src/core/retry.js";

const POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: "none",
};

function makeClock(): { now: number; clock: Clock; slept: number[] } {
  const state = { now: 0, slept: [] as number[] };
  const clock: Clock = {
    now: () => state.now,
    sleep: async (ms: number) => {
      state.slept.push(ms);
      state.now += ms;
    },
  };
  return { ...state, clock };
}

describe("computeBackoffDelay", () => {
  it("no jitter: delay equals min(maxDelayMs, baseDelayMs * 2^(n-1))", () => {
    const p = { baseDelayMs: 500, maxDelayMs: 30_000, jitter: "none" as const };
    expect(computeBackoffDelay(1, p)).toBe(500);   // 500 * 2^0
    expect(computeBackoffDelay(2, p)).toBe(1_000);  // 500 * 2^1
    expect(computeBackoffDelay(3, p)).toBe(2_000);  // 500 * 2^2
    expect(computeBackoffDelay(4, p)).toBe(4_000);  // 500 * 2^3
    expect(computeBackoffDelay(5, p)).toBe(8_000);  // 500 * 2^4
  });

  it("caps at maxDelayMs", () => {
    const p = { baseDelayMs: 500, maxDelayMs: 3_000, jitter: "none" as const };
    expect(computeBackoffDelay(10, p)).toBe(3_000);
  });

  it("full jitter: result is in [0, cap]", () => {
    const p = { baseDelayMs: 1000, maxDelayMs: 10_000, jitter: "full" as const };
    // retryCount=3 => cap = min(10000, 1000 * 2^2) = 4000
    for (let i = 0; i < 50; i++) {
      const delay = computeBackoffDelay(3, p);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(4000);
    }
  });

  it("full jitter with fixed rng returns rng * cap", () => {
    const p = { baseDelayMs: 500, maxDelayMs: 30_000, jitter: "full" as const };
    const rng = () => 0.5;
    // retry 2: cap = min(30000, 500 * 2^1) = 1000; floor(0.5 * 1001) = 500
    expect(computeBackoffDelay(2, p, rng)).toBe(500);
  });
});

describe("computeRetryDelay", () => {
  it("uses Retry-After when larger than computed delay", () => {
    const p = { baseDelayMs: 500, maxDelayMs: 30_000, jitter: "none" as const };
    expect(computeRetryDelay(1, p, 2_000)).toBe(2_000);
  });

  it("keeps computed delay when Retry-After is smaller", () => {
    const p = { baseDelayMs: 1_000, maxDelayMs: 30_000, jitter: "none" as const };
    // retry 1 no-jitter = 1000; Retry-After 100 is smaller
    expect(computeRetryDelay(1, p, 100)).toBe(1_000);
  });

  it("caps Retry-After at maxDelayMs * 4", () => {
    const p = { baseDelayMs: 500, maxDelayMs: 1_000, jitter: "none" as const };
    // Retry-After = 999999; cap = 4000
    expect(computeRetryDelay(1, p, 999_999)).toBe(4_000);
  });

  it("ignores Retry-After when 0 or undefined", () => {
    const p = { baseDelayMs: 500, maxDelayMs: 30_000, jitter: "none" as const };
    expect(computeRetryDelay(1, p, 0)).toBe(500);
    expect(computeRetryDelay(1, p, undefined)).toBe(500);
  });
});

describe("executeWithRetry", () => {
  it("returns the result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const r = await executeWithRetry(fn, POLICY);
    expect(r.result).toBe("ok");
    expect(r.attempts).toBe(1);
    expect(r.retries).toBe(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient errors and succeeds on second attempt", async () => {
    const { clock, slept } = makeClock();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new SyncError("transient", "timeout"))
      .mockResolvedValue("ok");

    const r = await executeWithRetry(fn, { ...POLICY, jitter: "none" }, { clock });
    expect(r.result).toBe("ok");
    expect(r.attempts).toBe(2);
    expect(r.retries).toBe(1);
    expect(slept).toEqual([500]); // baseDelayMs * 2^0
  });

  it("does not retry permanent errors", async () => {
    const fn = vi.fn().mockRejectedValue(new SyncError("permanent", "bad record"));
    await expect(executeWithRetry(fn, POLICY)).rejects.toThrow("bad record");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry fatal errors", async () => {
    const fn = vi.fn().mockRejectedValue(new SyncError("fatal", "auth failure"));
    await expect(executeWithRetry(fn, POLICY)).rejects.toThrow("auth failure");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("exhausts retries and rethrows after maxAttempts", async () => {
    const { clock } = makeClock();
    const fn = vi.fn().mockRejectedValue(new SyncError("transient", "flaky"));
    await expect(executeWithRetry(fn, { ...POLICY, jitter: "none" }, { clock })).rejects.toThrow("flaky");
    // 5 attempts = 1 initial + 4 retries
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it("retries unclassified errors once then escalates", async () => {
    const { clock } = makeClock();
    const unclassified = new Error("unexpected");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(unclassified)
      .mockRejectedValueOnce(unclassified);

    await expect(executeWithRetry(fn, POLICY, { clock })).rejects.toBe(unclassified);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries unclassified then succeeds on second attempt", async () => {
    const { clock } = makeClock();
    const fn = vi.fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValue("good");
    const r = await executeWithRetry(fn, POLICY, { clock });
    expect(r.result).toBe("good");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After from rate_limited SyncError", async () => {
    const { clock, slept } = makeClock();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new SyncError("rate_limited", "slow down", { retryAfterMs: 5_000 }))
      .mockResolvedValue("ok");

    const r = await executeWithRetry(fn, { ...POLICY, jitter: "none" }, { clock });
    expect(r.result).toBe("ok");
    // Retry-After 5000 > computed 500 => sleep 5000
    expect(slept[0]).toBe(5_000);
  });

  it("calls onRetry with retry count and delay", async () => {
    const { clock } = makeClock();
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new SyncError("transient", "err"))
      .mockRejectedValueOnce(new SyncError("transient", "err"))
      .mockResolvedValue("done");

    await executeWithRetry(fn, { ...POLICY, jitter: "none" }, { clock, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[1]).toBe(1); // retryCount 1
    expect(onRetry.mock.calls[1]?.[1]).toBe(2); // retryCount 2
  });

  it("aborts on signal before first attempt", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(executeWithRetry(fn, POLICY, { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(fn).not.toHaveBeenCalled();
  });

  it("stops retrying when signal aborts between attempts", async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new SyncError("transient", "err"));
    const clock: Clock = {
      now: () => 0,
      sleep: async () => {
        controller.abort(new Error("stopped"));
      },
    };
    await expect(executeWithRetry(fn, POLICY, { clock, signal: controller.signal })).rejects.toThrow("stopped");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
