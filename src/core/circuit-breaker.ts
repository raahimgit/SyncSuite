import { SyncError } from "./types.js";

export interface CircuitBreakerOptions {
  maxConsecutiveFailures: number;
}

// Distinguishes "this record is bad" from "the destination is down".
// After maxConsecutiveFailures retry-exhausted records, the breaker trips
// and throws a fatal SyncError, terminating the run with the checkpoint untouched.
export class CircuitBreaker {
  readonly maxConsecutiveFailures: number;
  private consecutiveFailures = 0;

  constructor(options: CircuitBreakerOptions) {
    if (options.maxConsecutiveFailures < 1) {
      throw new RangeError("maxConsecutiveFailures must be >= 1");
    }
    this.maxConsecutiveFailures = options.maxConsecutiveFailures;
  }

  get consecutiveFailureCount(): number {
    return this.consecutiveFailures;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  // Permanent record validation or transform failures do not indicate destination failure,
  // so they do not count toward tripping the circuit breaker.
  recordRetryExhaustedFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      throw new SyncError(
        "fatal",
        `circuit breaker tripped after ${this.consecutiveFailures} consecutive retry-exhausted record failures`,
      );
    }
  }
}
