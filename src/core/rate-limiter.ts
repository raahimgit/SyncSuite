import type { Clock } from "./types.js";
import { defaultClock } from "./types.js";

export interface RateLimiterOptions {
  requestsPerSecond: number;
  burst?: number;
  clock?: Clock;
}

export interface AcquireResult {
  waitedMs: number;
}

// Token-bucket rate limiter per job destination.
// Supports:
// - Refill rate: requestsPerSecond tokens/sec
// - Bucket capacity: burst (defaults to Math.max(1, Math.ceil(requestsPerSecond)))
// - Atomic token reservation for concurrent in-flight requests
// - 429 backoff / slowing via onRateLimited()
// - Injectable Clock for deterministic testing
export class TokenBucketRateLimiter {
  readonly requestsPerSecond: number;
  readonly burst: number;
  private readonly clock: Clock;

  private tokens: number;
  private lastRefillMs: number;
  private pausedUntilMs: number = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions) {
    if (options.requestsPerSecond <= 0) {
      throw new RangeError("requestsPerSecond must be > 0");
    }
    this.requestsPerSecond = options.requestsPerSecond;
    this.burst = options.burst ?? Math.max(1, Math.ceil(options.requestsPerSecond));
    if (this.burst < 1) {
      throw new RangeError("burst must be >= 1");
    }
    this.clock = options.clock ?? defaultClock;
    this.tokens = this.burst;
    this.lastRefillMs = this.clock.now();
  }

  // Refills tokens based on elapsed time since last refill
  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.lastRefillMs);
    if (elapsed > 0) {
      const addedTokens = (elapsed * this.requestsPerSecond) / 1000;
      this.tokens = Math.min(this.burst, this.tokens + addedTokens);
      this.lastRefillMs = now;
    }
  }

  // Called when destination returns a 429 / rate_limited error.
  // Drains remaining tokens and pauses the limiter.
  onRateLimited(retryAfterMs?: number): void {
    const now = this.clock.now();
    this.tokens = 0;
    this.lastRefillMs = now;
    const penaltyMs = retryAfterMs !== undefined && retryAfterMs > 0
      ? retryAfterMs
      : Math.max(1000, Math.ceil(1000 / this.requestsPerSecond));
    this.pausedUntilMs = Math.max(this.pausedUntilMs, now + penaltyMs);
  }

  // Acquires tokens (default 1). If tokens are unavailable or the limiter is paused,
  // waits until enough tokens are refilled. Returns the total wait time in ms.
  async acquire(tokensRequested = 1, signal?: AbortSignal): Promise<AcquireResult> {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("aborted");
    }

    // Serialize reservations to guarantee fair ordering and correct token accounting
    let releaseReservation!: () => void;
    const reservationLock = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });

    const previousChain = this.chain;
    this.chain = this.chain.then(() => reservationLock).catch(() => reservationLock);

    await previousChain;

    let waitMs = 0;
    try {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("aborted");
      }

      const now = this.clock.now();
      this.refill(now);

      // Check if paused due to rate-limit penalty
      let pauseWaitMs = 0;
      if (this.pausedUntilMs > now) {
        pauseWaitMs = this.pausedUntilMs - now;
      }

      // Check token availability
      if (this.tokens >= tokensRequested && pauseWaitMs === 0) {
        this.tokens -= tokensRequested;
        waitMs = 0;
      } else {
        // Calculate refill time needed
        const deficit = tokensRequested - this.tokens;
        const refillWaitMs = deficit > 0 ? Math.ceil((deficit * 1000) / this.requestsPerSecond) : 0;
        waitMs = Math.max(pauseWaitMs, refillWaitMs);

        // Deduct tokens (can go to 0 or advance future refill time)
        this.tokens = Math.max(0, this.tokens - tokensRequested);
        // Advance lastRefillMs to reflect consumed future tokens
        this.lastRefillMs = now + waitMs;
      }
    } finally {
      releaseReservation();
    }

    if (waitMs > 0) {
      await this.clock.sleep(waitMs, signal);
    }

    return { waitedMs: waitMs };
  }
}
