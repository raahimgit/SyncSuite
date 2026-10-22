import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../../src/core/circuit-breaker.js";
import { SyncError } from "../../src/core/types.js";

describe("CircuitBreaker", () => {
  it("does not trip before maxConsecutiveFailures is reached", () => {
    const cb = new CircuitBreaker({ maxConsecutiveFailures: 3 });
    expect(() => cb.recordRetryExhaustedFailure()).not.toThrow();
    expect(() => cb.recordRetryExhaustedFailure()).not.toThrow();
    expect(cb.consecutiveFailureCount).toBe(2);
  });

  it("trips on the Nth consecutive failure and throws a fatal SyncError", () => {
    const cb = new CircuitBreaker({ maxConsecutiveFailures: 3 });
    cb.recordRetryExhaustedFailure();
    cb.recordRetryExhaustedFailure();
    let threw: unknown;
    try {
      cb.recordRetryExhaustedFailure();
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(SyncError);
    expect((threw as SyncError).kind).toBe("fatal");
    expect((threw as SyncError).message).toContain("circuit breaker");
  });

  it("resets consecutive count after recordSuccess", () => {
    const cb = new CircuitBreaker({ maxConsecutiveFailures: 3 });
    cb.recordRetryExhaustedFailure();
    cb.recordRetryExhaustedFailure();
    cb.recordSuccess();
    expect(cb.consecutiveFailureCount).toBe(0);
    // Should not trip again immediately
    expect(() => cb.recordRetryExhaustedFailure()).not.toThrow();
    expect(() => cb.recordRetryExhaustedFailure()).not.toThrow();
  });

  it("trips again after reset when failures accumulate", () => {
    const cb = new CircuitBreaker({ maxConsecutiveFailures: 2 });
    cb.recordRetryExhaustedFailure();
    cb.recordSuccess();
    cb.recordRetryExhaustedFailure();
    expect(() => cb.recordRetryExhaustedFailure()).toThrow(SyncError);
  });

  it("rejects maxConsecutiveFailures < 1", () => {
    expect(() => new CircuitBreaker({ maxConsecutiveFailures: 0 })).toThrow(RangeError);
    expect(() => new CircuitBreaker({ maxConsecutiveFailures: -1 })).toThrow(RangeError);
  });

  it("a single failure trips when maxConsecutiveFailures is 1", () => {
    const cb = new CircuitBreaker({ maxConsecutiveFailures: 1 });
    expect(() => cb.recordRetryExhaustedFailure()).toThrow(SyncError);
  });
});
