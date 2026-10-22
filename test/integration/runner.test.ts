import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { JobBusyError, JobNotFoundError, LeaseLostError } from "../../src/core/errors.js";
import { parseJobSpec } from "../../src/core/job-spec.js";
import type { JobSpecInput } from "../../src/core/job-spec.js";
import { ConnectorRegistry } from "../../src/core/registry.js";
import { JobRunner } from "../../src/core/runner.js";
import { SyncError } from "../../src/core/types.js";
import type { Job } from "../../src/db/store.js";
import { MemoryDestination, MemorySource, makeRecords } from "../fixtures/memory-connectors.js";
import { createTestStore, describeDb } from "../helpers/db.js";
import type { TestStore } from "../helpers/db.js";

let counter = 0;

describeDb("JobRunner", () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await createTestStore();
  });
  afterAll(async () => {
    await t.close();
  });

  let source: MemorySource;
  let destination: MemoryDestination;
  let runner: JobRunner;

  beforeEach(() => {
    source = new MemorySource([]);
    destination = new MemoryDestination();
  });

  async function setup(overrides: Partial<JobSpecInput> = {}): Promise<Job> {
    const registry = new ConnectorRegistry();
    registry.registerSource("memory", () => source);
    registry.registerDestination("memory", () => destination);
    runner = new JobRunner({ store: t.store, registry, leaseTtlMs: 30_000, heartbeatIntervalMs: 60_000 });
    const spec = parseJobSpec({
      name: `job-${++counter}`,
      source: { type: "memory" },
      destination: { type: "memory" },
      batchSize: 10,
      concurrency: 1,
      transform: [
        { op: "concat", from: ["first_name", "last_name"], to: "full_name" },
        { op: "drop", fields: ["first_name", "last_name"] },
      ],
      ...overrides,
    });
    return t.store.createJob(spec);
  }

  it("syncs every record in batches, applies the transform, and persists the final checkpoint", async () => {
    const job = await setup();
    source.records = makeRecords(25);

    const result = await runner.run(job.name);

    expect(result.state).toBe("succeeded");
    expect(result.counters).toMatchObject({ discovered: 25, processed: 25, succeeded: 25, failed: 0, batches: 3 });
    expect(destination.rows.size).toBe(25);
    expect(destination.rows.get("r0")).toEqual({ id: 0, email: "u0@example.com", full_name: "F0 L0" });
    expect(source.calls).toEqual([null, { pos: 10 }, { pos: 20 }, { pos: 25 }]);
    expect((await t.store.load(job.id))?.cursor).toEqual({ pos: 25 });

    const stored = await t.store.getRun(result.runId);
    expect(stored?.state).toBe("succeeded");
    expect(stored?.counters.succeeded).toBe(25);
  });

  it("is incremental: a second run reads only from the checkpoint", async () => {
    const job = await setup();
    source.records = makeRecords(12);
    await runner.run(job.name);
    const writesAfterFirst = destination.writes.length;

    source.records = [...source.records, ...makeRecords(3, 12)];
    source.calls.length = 0;
    const second = await runner.run(job.name);

    expect(source.calls[0]).toEqual({ pos: 12 });
    expect(second.counters.discovered).toBe(3);
    expect(destination.writes.length - writesAfterFirst).toBe(3);
    expect(destination.rows.size).toBe(15);
  });

  it("dead-letters records that fail validation, writes the rest, and ends partial", async () => {
    const job = await setup({
      validation: { fields: { email: { pattern: "^[^@\\s]+@[^@\\s]+$" } } },
    });
    source.records = makeRecords(5);
    source.records[3] = { key: "r3", data: { id: 3, first_name: "A", last_name: "B", email: "not-an-email" } };

    const result = await runner.run(job.name);

    expect(result.state).toBe("partial");
    expect(result.counters).toMatchObject({ discovered: 5, succeeded: 4, failed: 1 });
    expect(destination.rows.has("r3")).toBe(false);
    expect((await t.store.load(job.id))?.cursor).toEqual({ pos: 5 });

    const dead = await t.store.listDeadLetters(job.id);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.recordKey).toBe("r3");
    expect(dead[0]?.errorKind).toBe("permanent");
    expect(JSON.stringify(dead[0]?.error)).toContain("pattern");
    expect(JSON.stringify(dead[0]?.error)).not.toContain("not-an-email");
  });

  it("dead-letters records whose transform fails permanently", async () => {
    const job = await setup();
    source.records = makeRecords(3);
    source.records[1] = { key: "r1", data: { id: 1, first_name: "OnlyFirst" } };

    const result = await runner.run(job.name);

    expect(result.state).toBe("partial");
    const dead = await t.store.listDeadLetters(job.id);
    expect(dead.map((d) => d.recordKey)).toEqual(["r1"]);
    expect(JSON.stringify(dead[0]?.error)).toContain("last_name");
  });

  it("with onRecordFailure=halt, fails the run, keeps the dead letter, and leaves the checkpoint before the failing batch", async () => {
    const job = await setup({
      onRecordFailure: "halt",
      batchSize: 5,
      validation: { fields: { email: { pattern: "^[^@\\s]+@[^@\\s]+$" } } },
    });
    source.records = makeRecords(12);
    source.records[7] = { key: "r7", data: { id: 7, first_name: "A", last_name: "B", email: "bad" } };

    const result = await runner.run(job.name);

    expect(result.state).toBe("failed");
    expect(result.error?.kind).toBe("fatal");
    expect((await t.store.load(job.id))?.cursor).toEqual({ pos: 5 });
    expect(destination.rows.has("r6")).toBe(true);
    expect(destination.rows.has("r8")).toBe(false);
    expect((await t.store.listDeadLetters(job.id)).map((d) => d.recordKey)).toEqual(["r7"]);
  });

  it("a destination failure fails the run at the last committed batch, and the next run resumes there", async () => {
    // Use circuit breaker threshold of 1 and maxAttempts=1 + fast clock so the
    // destination outage trips the breaker and fails the run (rather than
    // dead-lettering r12 and producing a "partial" result).
    const fakeClock = { now: () => 0, sleep: async () => {} };
    const registry = new ConnectorRegistry();
    registry.registerSource("memory", () => source);
    registry.registerDestination("memory", () => destination);
    const job = await setup({
      circuitBreaker: { maxConsecutiveFailures: 1 },
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: "none" },
    });
    runner = new JobRunner({ store: t.store, registry, leaseTtlMs: 30_000, heartbeatIntervalMs: 60_000, clock: fakeClock });

    source.records = makeRecords(25);
    let down = true;
    destination.onWrite = (req) => {
      if (down && req.key === "r12") throw new SyncError("transient", "destination unavailable");
    };

    const first = await runner.run(job.name);
    expect(first.state).toBe("failed");
    expect(first.error?.message).toContain("circuit breaker");
    expect((await t.store.load(job.id))?.cursor).toEqual({ pos: 10 });

    down = false;
    source.calls.length = 0;
    const second = await runner.run(job.name);

    expect(source.calls[0]).toEqual({ pos: 10 });
    expect(second.state).toBe("succeeded");
    expect(destination.rows.size).toBe(25);

    // r10 and r11 were written in run 1 and their content hashes were saved to the
    // delivery ledger per-record (before the circuit breaker tripped on r12).
    // Run 2 resumes from pos:10 but the ledger marks r10/r11 as unchanged —
    // they are NOT re-written. r12 had no ledger entry so it is written fresh.
    expect(second.counters.unchanged).toBe(2); // r10 and r11 skipped by ledger
    const r10Writes = destination.writes.filter((w) => w.key === "r10");
    expect(r10Writes).toHaveLength(1); // written exactly once (ledger prevents duplicate)
    const r12Writes = destination.writes.filter((w) => w.key === "r12");
    expect(r12Writes).toHaveLength(1); // written fresh in run 2
  });

  it("dry run reports what would happen and changes nothing", async () => {
    const job = await setup({ validation: { fields: { email: { pattern: "^[^@\\s]+@[^@\\s]+$" } } } });
    source.records = makeRecords(4);
    source.records[2] = { key: "r2", data: { id: 2, first_name: "A", last_name: "B", email: "bad" } };

    const result = await runner.run(job.name, { dryRun: true });

    expect(result.state).toBe("partial");
    expect(destination.writes).toHaveLength(0);
    expect(await t.store.load(job.id)).toBeNull();
    expect(await t.store.listDeadLetters(job.id)).toHaveLength(0);
    expect(result.counters).toMatchObject({ discovered: 4, planned: 3, failed: 1, succeeded: 0 });
    expect(result.dryRun?.map((e) => `${e.key}:${e.outcome}`)).toEqual([
      "r0:would_write",
      "r1:would_write",
      "r2:invalid",
      "r3:would_write",
    ]);
    expect(result.dryRun?.[0]?.plan?.action).toBe("create");
    expect((await t.store.getRun(result.runId))?.dryRun).toBe(true);
  });

  it("refuses to start a second run while one holds the lease", async () => {
    const job = await setup();
    source.records = makeRecords(3);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inside = new Promise<void>((r) => (entered = r));
    destination.onWrite = async () => {
      entered();
      await gate;
    };

    const first = runner.run(job.name);
    await inside;
    await expect(runner.run(job.name)).rejects.toBeInstanceOf(JobBusyError);
    release();
    expect((await first).state).toBe("succeeded");
  });

  it("stop request cancels the run and keeps the checkpoint at the last completed batch", async () => {
    const job = await setup();
    source.records = makeRecords(30);
    const controller = new AbortController();
    destination.onWrite = (_req, attempt) => {
      if (attempt === 13) controller.abort();
    };

    const result = await runner.run(job.name, { signal: controller.signal });

    expect(result.state).toBe("cancelled");
    expect(result.error).toBeUndefined();
    expect((await t.store.load(job.id))?.cursor).toEqual({ pos: 10 });
    expect((await t.store.getRun(result.runId))?.state).toBe("cancelled");
  });

  it("a worker that loses its lease cannot commit and is reported as such", async () => {
    const job = await setup();
    source.records = makeRecords(5);
    destination.onWrite = async (_req, attempt) => {
      if (attempt !== 3) return;
      await t.pool.query(`UPDATE "${t.schema}".leases SET expires_at = now() - interval '1 second' WHERE job_id = $1`, [job.id]);
      expect(await t.store.acquireLease(job.id, "other-worker", 60_000)).toBe(2n);
    };

    await expect(runner.run(job.name)).rejects.toBeInstanceOf(LeaseLostError);

    expect(await t.store.load(job.id)).toBeNull();
    const [run] = await t.store.listRuns(job.id);
    expect(run?.state).toBe("interrupted");
  });

  it("records a failed run when a connector type is unknown", async () => {
    const job = await setup({ destination: { type: "does-not-exist" } });
    const result = await runner.run(job.name);
    expect(result.state).toBe("failed");
    expect(result.error?.kind).toBe("fatal");
    expect(result.error?.message).toContain("does-not-exist");
  });

  it("rejects unknown jobs", async () => {
    await setup();
    await expect(runner.run("no-such-job")).rejects.toBeInstanceOf(JobNotFoundError);
  });

  it("persists run events", async () => {
    const job = await setup();
    source.records = makeRecords(3);
    const result = await runner.run(job.name);
    const events = (await t.store.listEvents(result.runId)).map((e) => e.event);
    expect(events).toEqual(["run.started", "batch.committed", "run.finished"]);
  });

  // ── Phase 3: delivery ledger, retries, circuit breaker, rate limiter ─────

  it("delivery ledger: unchanged records are skipped on second run without re-writing", async () => {
    const job = await setup({ transform: [], concurrency: 1 });
    source.records = makeRecords(5);

    const first = await runner.run(job.name);
    expect(first.state).toBe("succeeded");
    expect(first.counters.succeeded).toBe(5);

    const writesAfterFirst = destination.writes.length;
    source.calls.length = 0;

    // Reset checkpoint so runner re-scans the source records from the beginning
    await t.pool.query(`DELETE FROM "${t.schema}".checkpoints WHERE job_id = $1`, [job.id]);

    // Second run with unchanged records should skip all of them
    const second = await runner.run(job.name);
    expect(second.state).toBe("succeeded");
    expect(second.counters.unchanged).toBe(5);
    expect(second.counters.succeeded).toBe(0);
    expect(destination.writes.length - writesAfterFirst).toBe(0);
  });

  it("delivery ledger: changed content is re-written on second run", async () => {
    const job = await setup({ transform: [], concurrency: 1 });
    source.records = makeRecords(3);

    await runner.run(job.name);
    const writesAfterFirst = destination.writes.length;

    // Mutate one record's content
    source.records[1] = { key: "r1", data: { id: 1, first_name: "Changed" } };
    source.calls.length = 0;

    // Reset checkpoint so runner re-scans the source records from the beginning
    await t.pool.query(`DELETE FROM "${t.schema}".checkpoints WHERE job_id = $1`, [job.id]);

    const second = await runner.run(job.name);
    expect(second.state).toBe("succeeded");
    // 2 unchanged + 1 changed
    expect(second.counters.unchanged).toBe(2);
    expect(second.counters.succeeded).toBe(1);
    expect(destination.writes.length - writesAfterFirst).toBe(1);
    expect(destination.writes.at(-1)?.key).toBe("r1");
  });

  it("retries transient destination error then succeeds and records the correct counters", async () => {
    let attempt = 0;
    const job = await setup({
      transform: [],
      concurrency: 1,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, jitter: "none" },
    });
    source.records = makeRecords(3);

    destination.onWrite = async (req) => {
      if (req.key === "r1") {
        attempt++;
        if (attempt < 3) throw new SyncError("transient", "temporary failure");
      }
    };

    // Inject a fast clock so the test does not actually sleep
    const fakeClock = {
      now: () => 0,
      sleep: async () => {},
    };
    const registry = new ConnectorRegistry();
    registry.registerSource("memory", () => source);
    registry.registerDestination("memory", () => destination);
    runner = new JobRunner({ store: t.store, registry, leaseTtlMs: 30_000, heartbeatIntervalMs: 60_000, clock: fakeClock });

    const result = await runner.run(job.name);
    expect(result.state).toBe("succeeded");
    expect(result.counters.succeeded).toBe(3);
    expect(result.counters.retries).toBe(2); // 2 retries for r1
    expect(result.counters.failed).toBe(0);
  });

  it("retries exhausted: record goes to dead letter, run is partial", async () => {
    const job = await setup({
      transform: [],
      concurrency: 1,
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10, jitter: "none" },
    });
    source.records = makeRecords(3);

    destination.onWrite = (req) => {
      if (req.key === "r1") throw new SyncError("transient", "always fails");
    };

    const fakeClock = { now: () => 0, sleep: async () => {} };
    const registry = new ConnectorRegistry();
    registry.registerSource("memory", () => source);
    registry.registerDestination("memory", () => destination);
    runner = new JobRunner({ store: t.store, registry, leaseTtlMs: 30_000, heartbeatIntervalMs: 60_000, clock: fakeClock });

    const result = await runner.run(job.name);
    expect(result.state).toBe("partial");
    expect(result.counters.failed).toBe(1);
    const dead = await t.store.listDeadLetters(job.id);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.recordKey).toBe("r1");
    expect(dead[0]?.errorKind).toBe("transient");
  });

  it("permanent destination failure is dead-lettered immediately without retry", async () => {
    const job = await setup({
      transform: [],
      concurrency: 1,
      retry: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 10, jitter: "none" },
    });
    source.records = makeRecords(3);
    let writeCallsForR1 = 0;
    destination.onWrite = (req) => {
      if (req.key === "r1") {
        writeCallsForR1++;
        throw new SyncError("permanent", "schema mismatch");
      }
    };

    const result = await runner.run(job.name);
    expect(result.state).toBe("partial");
    expect(writeCallsForR1).toBe(1); // never retried
    const dead = await t.store.listDeadLetters(job.id);
    expect(dead[0]?.recordKey).toBe("r1");
    expect(dead[0]?.errorKind).toBe("permanent");
  });

  it("circuit breaker trips after maxConsecutiveFailures and leaves checkpoint before the failing batch", async () => {
    const job = await setup({
      transform: [],
      concurrency: 1,
      batchSize: 5,
      circuitBreaker: { maxConsecutiveFailures: 3 },
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: "none" },
    });
    source.records = makeRecords(15);

    // First batch of 5 succeeds entirely.
    // Second batch: all 5 records throw transient (retry-exhausted), circuit breaker trips on 3rd.
    const fakeClock = { now: () => 0, sleep: async () => {} };
    const registry = new ConnectorRegistry();
    registry.registerSource("memory", () => source);
    destination.onWrite = (req) => {
      // Records 5..14 are in the second and third batches; all fail.
      const n = parseInt(req.key.slice(1));
      if (n >= 5) throw new SyncError("transient", "destination down");
    };
    registry.registerDestination("memory", () => destination);
    runner = new JobRunner({ store: t.store, registry, leaseTtlMs: 30_000, heartbeatIntervalMs: 60_000, clock: fakeClock });
    const result = await runner.run(job.name);
    expect(result.state).toBe("failed");
    expect(result.error?.message).toContain("circuit breaker");
    // Checkpoint stays after the first batch (pos 5 was committed, second batch failed)
    expect((await t.store.load(job.id))?.cursor).toEqual({ pos: 5 });
  });

  it("dead-letter re-drive: resolved records are upserted to the ledger and succeed", async () => {
    // Create a dead letter manually, then retry it
    const job = await setup({ transform: [], concurrency: 1 });
    source.records = makeRecords(3);

    // First run: r1 permanently fails
    destination.onWrite = (req) => {
      if (req.key === "r1") throw new SyncError("permanent", "first fail");
    };
    await runner.run(job.name);

    const deadBefore = await t.store.listDeadLetters(job.id);
    expect(deadBefore).toHaveLength(1);
    expect(deadBefore[0]?.state).toBe("open");

    // Fix the destination and retry
    destination.onWrite = undefined;
    destination.rows.delete("r1");
    source.calls.length = 0;

    const retryResult = await runner.retry(job.name);
    expect(retryResult.state).toBe("succeeded");
    expect(retryResult.counters.succeeded).toBe(1);
    expect(retryResult.counters.failed).toBe(0);

    // Dead letter is now resolved
    const deadAfter = await t.store.listDeadLetters(job.id);
    expect(deadAfter[0]?.state).toBe("resolved");

    // Ledger was upserted for r1
    const ledger = await t.store.getLedgerEntry(job.id, "r1");
    expect(ledger).not.toBeNull();
  });

  it("rate limiter counters are recorded in run counters when wait time > 0", async () => {
    // Use a fast clock to avoid real sleeps while triggering the rate limiter path
    const sleepCalls: number[] = [];
    const fakeClock = {
      now: (() => {
        let t = 0;
        return () => t++;
      })(),
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
      },
    };
    const job = await setup({
      transform: [],
      concurrency: 1,
      batchSize: 5,
      // 1 request per second, burst 1 -> after first request every subsequent must wait
      rateLimit: { requestsPerSecond: 1, burst: 1 },
    });
    source.records = makeRecords(3);

    const registry = new ConnectorRegistry();
    registry.registerSource("memory", () => source);
    registry.registerDestination("memory", () => destination);
    runner = new JobRunner({ store: t.store, registry, leaseTtlMs: 30_000, heartbeatIntervalMs: 60_000, clock: fakeClock });

    const result = await runner.run(job.name);
    expect(result.state).toBe("succeeded");
    // After the first record, the limiter forces waits for subsequent records
    expect(result.counters.rateLimitWaits).toBeGreaterThan(0);
    expect(result.counters.rateLimitWaitMsTotal).toBeGreaterThanOrEqual(0);
  });
});

