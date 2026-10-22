import { performance } from "node:perf_hooks";
import { JobRunner } from "../src/core/runner.js";
import { ConnectorRegistry } from "../src/core/registry.js";
import { parseJobSpec } from "../src/core/job-spec.js";
import { emptyCounters } from "../src/core/types.js";
import { MemorySource, MemoryDestination, makeRecords } from "../test/fixtures/memory-connectors.js";
import type { StateStore, Job, Run } from "../src/db/store.js";

class RecoveryBenchStore {
  constructor(public savedCursor: unknown) {}

  async getJobByName(name: string): Promise<Job | null> {
    const spec = parseJobSpec({
      name,
      source: { type: "memory" },
      destination: { type: "memory" },
      batchSize: 100,
      concurrency: 4,
    });
    return {
      id: "bench-job-rec",
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
      id: "bench-run-rec",
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
  async load(): Promise<{ cursor: unknown } | null> {
    return { cursor: this.savedCursor };
  }
  async commit(): Promise<void> {}
  async getLedgerEntry(): Promise<null> { return null; }
  async upsertLedger(): Promise<void> {}
  async insertDeadLetter(): Promise<void> {}
  async insertEvent(): Promise<void> {}
}

export async function runCheckpointRecoveryBenchmark(datasetSize = 5_000, resumePos = 2_500): Promise<{
  datasetSize: number;
  resumePos: number;
  recoveryDurationMs: number;
  resumedRecordsProcessed: number;
}> {
  const store = new RecoveryBenchStore({ pos: resumePos }) as unknown as StateStore;
  const registry = new ConnectorRegistry();
  const source = new MemorySource(makeRecords(datasetSize));
  const destination = new MemoryDestination();

  registry.registerSource("memory", () => source);
  registry.registerDestination("memory", () => destination);

  const runner = new JobRunner({ store, registry });

  const start = performance.now();
  const result = await runner.run("recovery-bench");
  const end = performance.now();

  return {
    datasetSize,
    resumePos,
    recoveryDurationMs: Math.round((end - start) * 100) / 100,
    resumedRecordsProcessed: result.counters.processed,
  };
}
