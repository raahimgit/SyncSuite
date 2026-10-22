import { performance } from "node:perf_hooks";
import { JobRunner } from "../src/core/runner.js";
import { ConnectorRegistry } from "../src/core/registry.js";
import { parseJobSpec } from "../src/core/job-spec.js";
import { emptyCounters } from "../src/core/types.js";
import { MemorySource, MemoryDestination, makeRecords } from "../test/fixtures/memory-connectors.js";
import type { StateStore, Job, Run } from "../src/db/store.js";

class BenchMockStore {
  public checkpoints = new Map<string, { cursor: unknown }>();
  public ledger = new Map<string, { contentHash: string }>();

  async getJobByName(name: string): Promise<Job | null> {
    const spec = parseJobSpec({
      name,
      source: { type: "memory" },
      destination: { type: "memory" },
      batchSize: 500,
      concurrency: 8,
    });
    return {
      id: "bench-job-1",
      name,
      spec,
      specVersion: 1,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  async acquireLease(): Promise<bigint | null> { return 1n; }
  async heartbeat(): Promise<boolean> { return true; }
  async releaseLease(): Promise<void> {}
  async createRun(jobId: string): Promise<Run> {
    return {
      id: "bench-run-1",
      jobId,
      epoch: 1n,
      state: "running",
      trigger: "manual",
      dryRun: false,
      startedAt: new Date(),
      finishedAt: null,
      error: null,
      counters: emptyCounters(),
    };
  }
  async finishRun(): Promise<void> {}
  async load(jobId: string): Promise<{ cursor: unknown } | null> {
    return this.checkpoints.get(jobId) ?? null;
  }
  async commit(jobId: string, _epoch: bigint, _runId: string, cursor: unknown): Promise<void> {
    this.checkpoints.set(jobId, { cursor });
  }
  async getLedgerEntry(): Promise<null> { return null; }
  async upsertLedger(): Promise<void> {}
  async insertDeadLetter(): Promise<void> {}
  async insertEvent(): Promise<void> {}
}

export async function runThroughputBenchmark(recordCount = 10_000): Promise<{
  recordCount: number;
  durationMs: number;
  recordsPerSecond: number;
}> {
  const store = new BenchMockStore() as unknown as StateStore;
  const registry = new ConnectorRegistry();
  const source = new MemorySource(makeRecords(recordCount));
  const destination = new MemoryDestination();

  registry.registerSource("memory", () => source);
  registry.registerDestination("memory", () => destination);

  const runner = new JobRunner({ store, registry });

  const start = performance.now();
  const result = await runner.run("throughput-bench", { maxRecords: recordCount });
  const end = performance.now();

  const durationMs = end - start;
  const recordsPerSecond = Math.round((result.counters.processed / (durationMs / 1000)) * 100) / 100;

  return {
    recordCount,
    durationMs: Math.round(durationMs * 100) / 100,
    recordsPerSecond,
  };
}
