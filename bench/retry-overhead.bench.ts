import { performance } from "node:perf_hooks";
import { executeWithRetry } from "../src/core/retry.js";
import { SyncError } from "../src/core/types.js";

export async function runRetryOverheadBenchmark(iterations = 1_000): Promise<{
  iterations: number;
  totalDurationMs: number;
  overheadPerRetryMs: number;
}> {
  let simulatedAttempts = 0;

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    simulatedAttempts = 0;
    await executeWithRetry(
      async () => {
        simulatedAttempts++;
        if (simulatedAttempts === 1) {
          throw new SyncError("transient", "simulated transient error");
        }
        return "success";
      },
      { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: "none" },
    );
  }
  const end = performance.now();

  const totalDurationMs = end - start;
  const overheadPerRetryMs = Math.round((totalDurationMs / iterations) * 1000) / 1000;

  return {
    iterations,
    totalDurationMs: Math.round(totalDurationMs * 100) / 100,
    overheadPerRetryMs,
  };
}
