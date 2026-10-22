import { cpus, totalmem } from "node:os";
import { runThroughputBenchmark } from "./throughput.bench.js";
import { runRetryOverheadBenchmark } from "./retry-overhead.bench.js";
import { runCheckpointRecoveryBenchmark } from "./checkpoint-recovery.bench.js";

async function main() {
  console.log("=================================================");
  console.log("       SyncSuite Performance Benchmark Suite      ");
  console.log("=================================================");
  console.log(`Node.js Version: ${process.version}`);
  console.log(`OS Platform:     ${process.platform} (${process.arch})`);
  console.log(`CPU Cores:       ${cpus().length}x ${cpus()[0]?.model}`);
  console.log(`System Memory:   ${Math.round(totalmem() / (1024 * 1024 * 1024))} GB`);
  console.log("-------------------------------------------------");

  console.log("\n[1/3] Running Throughput Benchmark (10,000 records)...");
  const throughput = await runThroughputBenchmark(10_000);
  console.log(`  Records:            ${throughput.recordCount.toLocaleString()}`);
  console.log(`  Duration:           ${throughput.durationMs} ms`);
  console.log(`  Throughput:         ${throughput.recordsPerSecond.toLocaleString()} records/sec`);

  console.log("\n[2/3] Running Retry Overhead Benchmark (1,000 iterations)...");
  const retry = await runRetryOverheadBenchmark(1_000);
  console.log(`  Iterations:         ${retry.iterations.toLocaleString()}`);
  console.log(`  Total Duration:     ${retry.totalDurationMs} ms`);
  console.log(`  Overhead per Retry: ${retry.overheadPerRetryMs} ms`);

  console.log("\n[3/3] Running Checkpoint Recovery Benchmark (5,000 records, resume at 2,500)...");
  const recovery = await runCheckpointRecoveryBenchmark(5_000, 2_500);
  console.log(`  Dataset Size:       ${recovery.datasetSize.toLocaleString()}`);
  console.log(`  Resume Position:    ${recovery.resumePos.toLocaleString()}`);
  console.log(`  Recovery Latency:   ${recovery.recoveryDurationMs} ms`);
  console.log(`  Records Resumed:    ${recovery.resumedRecordsProcessed.toLocaleString()}`);

  console.log("\n=================================================");
  console.log("Benchmark execution completed successfully.");
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
