import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuplicateJobError, LeaseLostError } from "../../src/core/errors.js";
import { parseJobSpec } from "../../src/core/job-spec.js";
import { emptyCounters } from "../../src/core/types.js";
import { createTestStore, describeDb } from "../helpers/db.js";
import type { TestStore } from "../helpers/db.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const newSpec = () => parseJobSpec({ name: `job-${++n}`, source: { type: "memory" }, destination: { type: "memory" } });

describeDb("StateStore", () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await createTestStore();
  });
  afterAll(async () => {
    await t.close();
  });

  it("migrations are idempotent", async () => {
    expect(await t.store.migrate()).toEqual([]);
  });

  it("round-trips a job spec and rejects duplicate names", async () => {
    const spec = newSpec();
    const job = await t.store.createJob(spec);
    expect(job.spec).toEqual(spec);
    expect((await t.store.getJobByName(spec.name))?.id).toBe(job.id);
    await expect(t.store.createJob(spec)).rejects.toBeInstanceOf(DuplicateJobError);
  });

  describe("leases", () => {
    it("grants one holder at a time and increments the epoch on every acquisition", async () => {
      const job = await t.store.createJob(newSpec());
      expect(await t.store.acquireLease(job.id, "a", 60_000)).toBe(1n);
      expect(await t.store.acquireLease(job.id, "b", 60_000)).toBeNull();
      const epoch = 1n;
      await t.store.releaseLease(job.id, epoch);
      expect(await t.store.acquireLease(job.id, "b", 60_000)).toBe(2n);
    });

    it("lets another worker take an expired lease and marks the old run interrupted", async () => {
      const job = await t.store.createJob(newSpec());
      const epoch = await t.store.acquireLease(job.id, "a", 50);
      const run = await t.store.createRun(job.id, epoch as bigint, { trigger: "manual", dryRun: false });
      await sleep(120);
      expect(await t.store.acquireLease(job.id, "b", 60_000)).toBe(2n);
      const after = await t.store.getRun(run.id);
      expect(after?.state).toBe("interrupted");
      expect(after?.finishedAt).not.toBeNull();
    });

    it("heartbeat extends a lease and is refused for a stale epoch", async () => {
      const job = await t.store.createJob(newSpec());
      const epoch = (await t.store.acquireLease(job.id, "a", 100)) as bigint;
      expect(await t.store.heartbeat(job.id, "a", epoch, 5_000)).toBe(true);
      await sleep(150);
      expect(await t.store.acquireLease(job.id, "b", 60_000)).toBeNull();
      expect(await t.store.heartbeat(job.id, "a", 99n, 5_000)).toBe(false);
      expect(await t.store.heartbeat(job.id, "someone-else", epoch, 5_000)).toBe(false);
    });
  });

  describe("checkpoints", () => {
    it("rejects a commit from a stale epoch and leaves the checkpoint untouched", async () => {
      const job = await t.store.createJob(newSpec());
      const stale = (await t.store.acquireLease(job.id, "a", 50)) as bigint;
      const staleRun = await t.store.createRun(job.id, stale, { trigger: "manual", dryRun: false });
      await sleep(120);
      const current = (await t.store.acquireLease(job.id, "b", 60_000)) as bigint;
      const currentRun = await t.store.createRun(job.id, current, { trigger: "manual", dryRun: false });

      await expect(t.store.commit(job.id, stale, staleRun.id, { pos: 100 })).rejects.toBeInstanceOf(LeaseLostError);
      expect(await t.store.load(job.id)).toBeNull();

      await t.store.commit(job.id, current, currentRun.id, { pos: 7 }, { ...emptyCounters(), discovered: 7, succeeded: 7 });
      const cp = await t.store.load(job.id);
      expect(cp?.cursor).toEqual({ pos: 7 });
      expect(cp?.epoch).toBe(current);
      expect((await t.store.getRun(currentRun.id))?.counters.succeeded).toBe(7);
    });

    it("overwrites the previous checkpoint on a later commit", async () => {
      const job = await t.store.createJob(newSpec());
      const epoch = (await t.store.acquireLease(job.id, "a", 60_000)) as bigint;
      const run = await t.store.createRun(job.id, epoch, { trigger: "manual", dryRun: false });
      await t.store.commit(job.id, epoch, run.id, { pos: 1 });
      await t.store.commit(job.id, epoch, run.id, { pos: 2 });
      expect((await t.store.load(job.id))?.cursor).toEqual({ pos: 2 });
    });
  });

  describe("runs", () => {
    it("finishRun does not overwrite a run that is no longer running", async () => {
      const job = await t.store.createJob(newSpec());
      const epoch = (await t.store.acquireLease(job.id, "a", 50)) as bigint;
      const run = await t.store.createRun(job.id, epoch, { trigger: "manual", dryRun: false });
      await sleep(120);
      await t.store.acquireLease(job.id, "b", 60_000);
      expect(await t.store.finishRun(run.id, "succeeded", emptyCounters())).toBe(false);
      expect((await t.store.getRun(run.id))?.state).toBe("interrupted");
    });
  });

  describe("dead letters", () => {
    it("updates the open dead letter for a record instead of adding a row per failure", async () => {
      const job = await t.store.createJob(newSpec());
      const epoch = (await t.store.acquireLease(job.id, "a", 60_000)) as bigint;
      const run = await t.store.createRun(job.id, epoch, { trigger: "manual", dryRun: false });
      const base = { jobId: job.id, runId: run.id, recordKey: "k1", errorKind: "permanent" };

      await t.store.insertDeadLetter({ ...base, payload: { v: 1 }, error: { message: "first" } });
      await t.store.insertDeadLetter({ ...base, payload: { v: 2, big: 10n }, error: { message: "second" } });

      const rows = await t.store.listDeadLetters(job.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.attempts).toBe(2);
      expect(rows[0]?.error).toEqual({ message: "second" });
      expect(rows[0]?.payload).toEqual({ v: 2, big: { $bigint: "10" } });
    });
  });

  describe("events", () => {
    it("returns events in insertion order", async () => {
      const job = await t.store.createJob(newSpec());
      const epoch = (await t.store.acquireLease(job.id, "a", 60_000)) as bigint;
      const run = await t.store.createRun(job.id, epoch, { trigger: "manual", dryRun: false });
      await t.store.insertEvent(run.id, "info", "one", { a: 1 });
      await t.store.insertEvent(run.id, "warn", "two");
      const events = await t.store.listEvents(run.id);
      expect(events.map((e) => e.event)).toEqual(["one", "two"]);
      expect(events[0]?.data).toEqual({ a: 1 });
    });
  });
});
