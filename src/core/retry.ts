import { SyncError } from "./types.js";
import type { Clock, Rng } from "./types.js";
import { defaultClock } from "./types.js";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: "full" | "none";
}

export interface RetryOptions {
  signal?: AbortSignal;
  clock?: Clock;
  rng?: Rng;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export interface RetryResult<T> {
  result: T;
  attempts: number;
  retries: number;
}

// Computes delay for retry count n (1-based: 1 for first retry, 2 for second...)
// Delay formula: min(maxDelayMs, baseDelayMs * 2^(n-1))
// Under full jitter: random(0, delay)
export function computeBackoffDelay(
  retryCount: number,
  policy: Pick<RetryPolicy, "baseDelayMs" | "maxDelayMs" | "jitter">,
  rng: Rng = Math.random,
): number {
  const exponent = Math.max(0, retryCount - 1);
  // Cap exponent calculation to avoid overflow
  const factor = exponent >= 30 ? Number.POSITIVE_INFINITY : 2 ** exponent;
  const rawCap = policy.baseDelayMs * factor;
  const cap = Math.min(policy.maxDelayMs, rawCap);

  if (policy.jitter === "none") {
    return cap;
  }
  return Math.floor(rng() * (cap + 1));
}

// Server-provided Retry-After overrides computed delay if larger, capped at maxDelayMs * 4
export function computeRetryDelay(
  retryCount: number,
  policy: Pick<RetryPolicy, "baseDelayMs" | "maxDelayMs" | "jitter">,
  retryAfterMs?: number,
  rng: Rng = Math.random,
): number {
  let delay = computeBackoffDelay(retryCount, policy, rng);
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    const cappedRetryAfter = Math.min(retryAfterMs, policy.maxDelayMs * 4);
    if (cappedRetryAfter > delay) {
      delay = cappedRetryAfter;
    }
  }
  return delay;
}

// Executes an async function with retry according to policy.
// Rules:
// - Permanent and fatal SyncErrors are NOT retried and fail immediately.
// - Transient and rate_limited SyncErrors are retried up to maxAttempts.
// - Unclassified errors (non-SyncErrors) are retried once as transient, then escalated.
// - Retry-After from SyncError is honored (capped at maxDelayMs * 4).
// - Injectable clock and RNG allow deterministic tests.
export async function executeWithRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  options: RetryOptions = {},
): Promise<RetryResult<T>> {
  const clock = options.clock ?? defaultClock;
  const rng = options.rng ?? Math.random;
  let attempt = 0;
  let retries = 0;
  let unclassifiedRetries = 0;

  while (true) {
    attempt++;
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("aborted");
    }

    try {
      const result = await fn(attempt);
      return { result, attempts: attempt, retries };
    } catch (err) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? err;
      }

      let retryable = false;
      let retryAfterMs: number | undefined;

      if (err instanceof SyncError) {
        if (err.kind === "permanent" || err.kind === "fatal") {
          throw err;
        }
        if (err.kind === "transient" || err.kind === "rate_limited") {
          retryable = true;
          retryAfterMs = err.retryAfterMs;
        }
      } else {
        // Unclassified error: retried once as transient, then escalated
        if (unclassifiedRetries === 0) {
          retryable = true;
          unclassifiedRetries++;
        } else {
          // Escalated: rethrow original error
          throw err;
        }
      }

      if (!retryable || attempt >= policy.maxAttempts) {
        throw err;
      }

      retries++;
      const delay = computeRetryDelay(retries, policy, retryAfterMs, rng);
      if (options.onRetry) {
        options.onRetry(err, retries, delay);
      }

      await clock.sleep(delay, options.signal);
    }
  }
}
