import { describe, it, expect } from "vitest";
import { JobRunner } from "../../src/core/runner.js";
import { ConnectorRegistry } from "../../src/core/registry.js";
import { parseJobSpec } from "../../src/core/job-spec.js";
import { MemorySource, MemoryDestination, makeRecords } from "../fixtures/memory-connectors.js";
import { SyncError, emptyCounters } from "../../src/core/types.js";
import type { StateStore, Job, DeadLetter, Run } from "../../src/db/store.js";

// Minimal in-memory state store for pure unit-level failure matrix testing
class InMemoryStore {
  public jobs = new Map<string, Job>();
  public checkpoints = new Map<string, { cursor: unknown; counters: unknown }>();
  public deadLetters: Array<Omit<DeadLetter, "id" | "firstFailedAt" | "lastAttemptAt">> = [];
  public runs = new Map<string, Run>();
  public ledger = new Map<string, { contentHash: string }>();
  public events: unknown[] = [];

  async getJobByName(name: string): Promise<Job | null> {
    return this.jobs.get(name) ?? null;
  }

  async acquireLease(): Promise<bigint | null> {
    return 1n;
  }

  async heartbeat(): Promise<boolean> {
    return true;
  }

  async releaseLease(): Promise<void> {}

  async createRun(jobId: string, epoch: bigint | null, opts: { trigger: string; dryRun: boolean }): Promise<Run> {
    const run: Run = {
      id: "run-mock-1",
      jobId,
      epoch,
      state: "running",
      trigger: opts.trigger as "manual",
      dryRun: opts.dryRun,
      startedAt: new Date(),
      finishedAt: null,
      error: null,
      counters: emptyCounters(),
    };
    this.runs.set(run.id, run);
    return run;
  }

  async finishRun(runId: string, state: string, counters: unknown, error?: unknown): Promise<void> {
    const r = this.runs.get(runId);
    if (r) {
      r.state = state as "succeeded";
      r.counters = counters as typeof r.counters;
      if (error) r.error = error as typeof r.error;
    }
  }

  async load(jobId: string): Promise<{ cursor: unknown } | null> {
    return this.checkpoints.get(jobId) ?? null;
  }

  async commit(jobId: string, _epoch: bigint, _runId: string, cursor: unknown, counters: unknown): Promise<void> {
    this.checkpoints.set(jobId, { cursor, counters });
  }

  async getLedgerEntry(jobId: string, recordKey: string): Promise<{ contentHash: string } | null> {
    return this.ledger.get(`${jobId}:${recordKey}`) ?? null;
  }

  async upsertLedger(jobId: string, recordKey: string, contentHash: string): Promise<void> {
    this.ledger.set(`${jobId}:${recordKey}`, { contentHash });
  }

  async insertDeadLetter(entry: Omit<DeadLetter, "id" | "firstFailedAt" | "lastAttemptAt">): Promise<void> {
    this.deadLetters.push(entry);
  }

  async insertEvent(_runId: string, _level: string, event: string, data: Record<string, unknown>): Promise<void> {
    this.events.push({ event, data });
  }
}

describe("Failure and Recovery Matrix", () => {
  function createHarness() {
    const store = new InMemoryStore() as unknown as StateStore & InMemoryStore;
    const registry = new ConnectorRegistry();
    let source: MemorySource = new MemorySource([]);
    let destination: MemoryDestination = new MemoryDestination();

    registry.registerSource("memory", () => source);
    registry.registerDestination("memory", () => destination);

    const jobSpec = parseJobSpec({
      name: "failure-test-job",
      source: { type: "memory" },
      destination: { type: "memory" },
      batchSize: 5,
      concurrency: 2,
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20, jitter: "none" },
    });

    const job: Job = {
      id: "job-1",
      name: "failure-test-job",
      spec: jobSpec,
      specVersion: 1,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    store.jobs.set(job.name, job);

    return {
      store,
      registry,
      job,
      setSource: (s: MemorySource) => { source = s; },
      setDestination: (d: MemoryDestination) => { destination = d; },
    };
  }

  it("Scenario 1: Duplicate records are detected and skipped via delivery ledger", async () => {
    const { store, registry, job, setSource, setDestination } = createHarness();
    const records = makeRecords(5);
    setSource(new MemorySource(records));
    const dest = new MemoryDestination();
    setDestination(dest);

    const runner = new JobRunner({ store, registry });
    // First run delivers 5 records
    const r1 = await runner.run(job.name);
    expect(r1.counters.succeeded).toBe(5);
    expect(r1.counters.unchanged).toBe(0);

    // Second run re-encountering duplicate records:
    // delivery ledger detects identical content hashes and skips destination writes
    store.checkpoints.delete(job.id);
    setSource(new MemorySource(records));
    const r2 = await runner.run(job.name);
    expect(r2.counters.unchanged).toBe(5);
    expect(dest.writes.length).toBe(5); // No additional writes executed
  });

  it("Scenario 2: Interrupted sync aborts cleanly and leaves checkpoint at last committed batch", async () => {
    const { store, registry, job, setSource, setDestination } = createHarness();
    const records = makeRecords(10);
    setSource(new MemorySource(records));
    const dest = new MemoryDestination();
    setDestination(dest);

    const controller = new AbortController();
    const runner = new JobRunner({ store, registry });

    // Abort after first batch
    let batchCount = 0;
    const originalCommit = store.commit.bind(store);
    store.commit = async (...args) => {
      await originalCommit(...args);
      batchCount++;
      if (batchCount === 1) {
        controller.abort();
      }
    };

    const r = await runner.run(job.name, { signal: controller.signal });
    expect(r.state).toBe("cancelled");
    expect(store.checkpoints.get(job.id)?.cursor).toEqual({ pos: 5 });
  });

  it("Scenario 3: Transient destination errors are retried up to maxAttempts", async () => {
    const { store, registry, job, setSource, setDestination } = createHarness();
    setSource(new MemorySource(makeRecords(2)));

    let attempts = 0;
    const dest = new MemoryDestination(async () => {
      attempts++;
      if (attempts === 1) {
        throw new SyncError("transient", "network glitch");
      }
    });
    setDestination(dest);

    const runner = new JobRunner({ store, registry });
    const result = await runner.run(job.name);
    expect(result.state).toBe("succeeded");
    expect(result.counters.retries).toBe(1);
    expect(result.counters.succeeded).toBe(2);
  });

  it("Scenario 4: Checkpoint recovery resumes from last cursor position", async () => {
    const { store, registry, job, setSource, setDestination } = createHarness();
    store.checkpoints.set(job.id, { cursor: { pos: 5 }, counters: {} });

    const records = makeRecords(10);
    const source = new MemorySource(records);
    setSource(source);
    setDestination(new MemoryDestination());

    const runner = new JobRunner({ store, registry });
    const result = await runner.run(job.name);
    expect(result.state).toBe("succeeded");
    // Reads only records starting from pos 5 (records 5 to 9)
    expect(result.counters.succeeded).toBe(5);
    expect(source.calls[0]).toEqual({ pos: 5 });
  });

  it("Scenario 5: Permanent failure dead-letters the bad record without failing the job", async () => {
    const { store, registry, job, setSource, setDestination } = createHarness();
    const records = makeRecords(3);
    setSource(new MemorySource(records));

    const dest = new MemoryDestination(async (req) => {
      if (req.key === "r1") {
        throw new SyncError("permanent", "Invalid customer account ID format");
      }
    });
    setDestination(dest);

    const runner = new JobRunner({ store, registry });
    const result = await runner.run(job.name);

    expect(result.state).toBe("partial");
    expect(result.counters.succeeded).toBe(2);
    expect(result.counters.failed).toBe(1);
    expect(store.deadLetters).toHaveLength(1);
    expect(store.deadLetters[0]?.recordKey).toBe("r1");
    expect(store.deadLetters[0]?.errorKind).toBe("permanent");
  });

  it("Scenario 6: Dead-letter payload redaction masks sensitive fields", async () => {
    const { store, registry, job, setSource, setDestination } = createHarness();
    setSource(new MemorySource([
      { key: "r0", data: { id: 10, email: "user@example.com", password: "raw-password-123", apiKey: "secret-key" } },
    ]));

    const dest = new MemoryDestination(async () => {
      throw new SyncError("permanent", "Account rejected");
    });
    setDestination(dest);

    const runner = new JobRunner({ store, registry, redactDeadLetterPayload: true });
    await runner.run(job.name);

    expect(store.deadLetters).toHaveLength(1);
    const payload = store.deadLetters[0]?.payload as Record<string, unknown>;
    expect(payload["password"]).toBe("[REDACTED]");
    expect(payload["apiKey"]).toBe("[REDACTED]");
    expect(payload["email"]).toBe("user@example.com");
  });
});
