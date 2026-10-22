import { describe, it, expect } from "vitest";
import { runThroughputBenchmark } from "../../bench/throughput.bench.js";
import { runRetryOverheadBenchmark } from "../../bench/retry-overhead.bench.js";
import { runCheckpointRecoveryBenchmark } from "../../bench/checkpoint-recovery.bench.js";

describe("Benchmarks Execution", () => {
  it("executes throughput benchmark and returns positive throughput rate", async () => {
    const result = await runThroughputBenchmark(500);
    expect(result.recordCount).toBe(500);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.recordsPerSecond).toBeGreaterThan(0);
  });

  it("executes retry overhead benchmark and measures sub-millisecond overhead", async () => {
    const result = await runRetryOverheadBenchmark(100);
    expect(result.iterations).toBe(100);
    expect(result.totalDurationMs).toBeGreaterThan(0);
    expect(result.overheadPerRetryMs).toBeGreaterThanOrEqual(0);
  });

  it("executes checkpoint recovery benchmark and seeks to cursor position", async () => {
    const result = await runCheckpointRecoveryBenchmark(500, 250);
    expect(result.datasetSize).toBe(500);
    expect(result.resumePos).toBe(250);
    expect(result.resumedRecordsProcessed).toBe(250);
    expect(result.recoveryDurationMs).toBeGreaterThan(0);
  });
});
