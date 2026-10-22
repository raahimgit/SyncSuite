import { describe, expect, it, vi } from "vitest";
import { TokenBucketRateLimiter } from "../../src/core/rate-limiter.js";
import type { Clock } from "../../src/core/types.js";

function makeClock(startMs = 0): { state: { now: number; slept: number[] }; clock: Clock } {
  const state: { now: number; slept: number[] } = { now: startMs, slept: [] };
  const clock: Clock = {
    now: () => state.now,
    sleep: async (ms: number) => {
      state.slept.push(ms);
      state.now += ms;
    },
  };
  return { state, clock };
}


describe("TokenBucketRateLimiter", () => {
  it("allows immediate acquisition when bucket is full", async () => {
    const { clock } = makeClock();
    const limiter = new TokenBucketRateLimiter({ requestsPerSecond: 10, burst: 5, clock });
    const r = await limiter.acquire(1);
    expect(r.waitedMs).toBe(0);
  });

  it("waits when tokens are depleted", async () => {
    const { clock } = makeClock();
    const limiter = new TokenBucketRateLimiter({ requestsPerSecond: 10, burst: 2, clock });
    // Drain 2 tokens immediately
    await limiter.acquire(1);
    await limiter.acquire(1);
    // Third acquire must wait for refill: 1 token at 10 rps = 100ms
    const r = await limiter.acquire(1);
    expect(r.waitedMs).toBeGreaterThan(0);
  });

  it("defaults burst to ceil(requestsPerSecond)", () => {
    const { clock } = makeClock();
    const limiter = new TokenBucketRateLimiter({ requestsPerSecond: 3.5, clock });
    expect(limiter.burst).toBe(4);
  });

  it("rejects requestsPerSecond <= 0", () => {
    const { clock } = makeClock();
    expect(() => new TokenBucketRateLimiter({ requestsPerSecond: 0, clock })).toThrow(RangeError);
    expect(() => new TokenBucketRateLimiter({ requestsPerSecond: -1, clock })).toThrow(RangeError);
  });

  it("slows down after onRateLimited is called", async () => {
    const { state, clock } = makeClock(0);
    const limiter = new TokenBucketRateLimiter({ requestsPerSecond: 100, burst: 100, clock });
    // Drain the bucket
    for (let i = 0; i < 100; i++) await limiter.acquire(1);
    // Report a 429 with 2s penalty
    limiter.onRateLimited(2_000);
    // Next acquire should wait at least 2000ms
    const r = await limiter.acquire(1);
    expect(r.waitedMs).toBeGreaterThanOrEqual(2_000);
    expect(state.now).toBeGreaterThanOrEqual(2_000);
  });

  it("aborts on signal before waiting", async () => {
    const { clock } = makeClock();
    const limiter = new TokenBucketRateLimiter({ requestsPerSecond: 1, burst: 1, clock });
    await limiter.acquire(1); // drain
    const controller = new AbortController();
    controller.abort(new Error("abort"));
    await expect(limiter.acquire(1, controller.signal)).rejects.toThrow("abort");
  });

  it("serializes concurrent acquisitions to avoid token over-spending", async () => {
    const { state } = makeClock(0);
    // Mock sleep to advance time but record sleeps
    const slept: number[] = [];
    const serialClock: Clock = {
      now: () => state.now,
      sleep: async (ms: number) => {
        slept.push(ms);
        state.now += ms;
      },
    };
    const limiter = new TokenBucketRateLimiter({ requestsPerSecond: 1, burst: 2, clock: serialClock });
    // Fire 4 concurrent acquires: 2 should be instant, 2 must wait
    const results = await Promise.all([
      limiter.acquire(),
      limiter.acquire(),
      limiter.acquire(),
      limiter.acquire(),
    ]);
    const immediates = results.filter((r) => r.waitedMs === 0);
    const waits = results.filter((r) => r.waitedMs > 0);
    // At most 2 immediate (burst = 2), at least 2 waited
    expect(immediates.length).toBeLessThanOrEqual(2);
    expect(waits.length).toBeGreaterThanOrEqual(2);
    // No double-counting of tokens: total wait >= 2000ms worth
    expect(slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2_000);
  });

  it("refills tokens over time", async () => {
    const { state, clock } = makeClock(0);
    const limiter = new TokenBucketRateLimiter({ requestsPerSecond: 10, burst: 10, clock });
    // Drain all tokens
    for (let i = 0; i < 10; i++) await limiter.acquire(1);
    // Advance time by 1 second
    state.now += 1_000;
    // Should be able to acquire without waiting (10 tokens refilled)
    const r = await limiter.acquire(1);
    expect(r.waitedMs).toBe(0);
  });

  it("rate bounds throughput: N tokens over time matches requestsPerSecond", async () => {
    const { state, clock } = makeClock(0);
    const requestsPerSecond = 5;
    const limiter = new TokenBucketRateLimiter({ requestsPerSecond, burst: 1, clock });
    const n = 10;
    for (let i = 0; i < n; i++) {
      await limiter.acquire(1);
    }
    // n requests at 5 rps should take at least (n-1)/rps seconds
    const minExpectedMs = ((n - 1) / requestsPerSecond) * 1000;
    expect(state.now).toBeGreaterThanOrEqual(minExpectedMs);
  });

  it("onRateLimited with no retryAfterMs applies a default penalty", async () => {
    const { state, clock } = makeClock(0);
    const limiter = new TokenBucketRateLimiter({ requestsPerSecond: 100, burst: 10, clock });
    for (let i = 0; i < 10; i++) await limiter.acquire(1);
    limiter.onRateLimited(); // no retryAfterMs
    const r = await limiter.acquire(1);
    // Should still wait some penalty amount
    expect(r.waitedMs).toBeGreaterThan(0);
    expect(state.now).toBeGreaterThan(0);
  });

  it("mock rng in test is not needed: real Math.random works", () => {
    expect(() => {
      const limiter = new TokenBucketRateLimiter({ requestsPerSecond: 10 });
      expect(limiter.requestsPerSecond).toBe(10);
    }).not.toThrow();
  });

  it("spy confirms acquire calls sleep when tokens run out", async () => {
    const slept: number[] = [];
    const state = { now: 0 };
    const clock: Clock = {
      now: () => state.now,
      sleep: async (ms: number) => {
        slept.push(ms);
        state.now += ms;
      },
    };
    const limiter = new TokenBucketRateLimiter({ requestsPerSecond: 2, burst: 1, clock });
    await limiter.acquire(1); // immediate
    await limiter.acquire(1); // should sleep ~500ms for 1 token at 2rps
    expect(slept.length).toBe(1);
    expect(slept[0]).toBeGreaterThan(0);
    vi.restoreAllMocks();
  });
});
