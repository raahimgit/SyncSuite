import { describe, it, expect } from "vitest";
import { MetricsRegistry } from "../../src/core/metrics.js";

describe("MetricsRegistry", () => {
  it("tracks active runs and cumulative totals", () => {
    const reg = new MetricsRegistry(() => 1000);
    expect(reg.getSnapshot().activeRuns).toBe(0);

    reg.recordRunStarted();
    expect(reg.getSnapshot().activeRuns).toBe(1);
    expect(reg.getSnapshot().totals.runsStarted).toBe(1);

    reg.recordRunFinished("succeeded");
    expect(reg.getSnapshot().activeRuns).toBe(0);
    expect(reg.getSnapshot().totals.runsSucceeded).toBe(1);
  });

  it("records run metrics and computes throughput", () => {
    const reg = new MetricsRegistry();
    reg.recordRunMetrics("orders-sync", {
      discovered: 100,
      processed: 100,
      succeeded: 95,
      unchanged: 3,
      failed: 2,
      durationMs: 2000,
      runState: "succeeded",
    });

    const snapshot = reg.getSnapshot();
    const jobMetrics = snapshot.jobs["orders-sync"];
    expect(jobMetrics).toBeDefined();
    expect(jobMetrics?.counters.processed).toBe(100);
    expect(jobMetrics?.counters.succeeded).toBe(95);
    expect(jobMetrics?.counters.failed).toBe(2);
    // 100 records in 2 seconds = 50 rec/sec
    expect(jobMetrics?.throughputPerSecond).toBe(50);
  });

  it("accumulates totals across multiple runs for the same job", () => {
    const reg = new MetricsRegistry();
    reg.recordRunMetrics("users-sync", {
      discovered: 50,
      processed: 50,
      succeeded: 50,
      unchanged: 0,
      failed: 0,
      durationMs: 1000,
      runState: "succeeded",
    });

    reg.recordRunMetrics("users-sync", {
      discovered: 30,
      processed: 30,
      succeeded: 28,
      unchanged: 0,
      failed: 2,
      durationMs: 1000,
      runState: "failed",
    });

    const job = reg.getSnapshot().jobs["users-sync"];
    expect(job?.counters.processed).toBe(80);
    expect(job?.counters.succeeded).toBe(78);
    expect(job?.counters.failed).toBe(2);
    expect(reg.getSnapshot().totals.processed).toBe(80);
  });

  it("generates Prometheus format text with valid metrics and types", () => {
    const reg = new MetricsRegistry(() => Date.now() - 60_000);
    reg.recordRunStarted();
    reg.recordRunFinished("succeeded");
    reg.recordRetry();
    reg.recordRateLimited();
    reg.recordRunMetrics("sync-prod", {
      discovered: 200,
      processed: 200,
      succeeded: 200,
      unchanged: 0,
      failed: 0,
      durationMs: 4000,
      runState: "succeeded",
    });

    const prom = reg.toPrometheus();
    expect(prom).toContain("# HELP syncsuite_uptime_seconds");
    expect(prom).toContain("# TYPE syncsuite_records_processed_total counter");
    expect(prom).toContain("syncsuite_records_processed_total 200");
    expect(prom).toContain("syncsuite_retries_total 1");
    expect(prom).toContain("syncsuite_rate_limit_events_total 1");
    expect(prom).toContain('syncsuite_job_records_processed_total{job="sync-prod"} 200');
    expect(prom).toContain('syncsuite_job_last_throughput_records_per_sec{job="sync-prod"} 50');
  });
});
