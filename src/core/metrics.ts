export interface JobMetricsSnapshot {
  jobName: string;
  counters: {
    discovered: number;
    processed: number;
    succeeded: number;
    unchanged: number;
    failed: number;
    retries: number;
    rateLimited: number;
  };
  durationMs: number;
  throughputPerSecond: number;
  lastRunState?: string;
  lastRunFinishedAt?: string;
}

export interface SystemMetricsSnapshot {
  timestamp: string;
  uptimeSeconds: number;
  activeRuns: number;
  jobs: Record<string, JobMetricsSnapshot>;
  totals: {
    discovered: number;
    processed: number;
    succeeded: number;
    unchanged: number;
    failed: number;
    retries: number;
    rateLimited: number;
    runsStarted: number;
    runsSucceeded: number;
    runsFailed: number;
  };
}

export class MetricsRegistry {
  private readonly startedAt: number;
  private activeRunsCount = 0;
  private readonly jobMetrics = new Map<string, JobMetricsSnapshot>();
  private readonly totals = {
    discovered: 0,
    processed: 0,
    succeeded: 0,
    unchanged: 0,
    failed: 0,
    retries: 0,
    rateLimited: 0,
    runsStarted: 0,
    runsSucceeded: 0,
    runsFailed: 0,
  };

  constructor(clock: () => number = () => Date.now()) {
    this.startedAt = clock();
  }

  recordRunStarted(): void {
    this.activeRunsCount++;
    this.totals.runsStarted++;
  }

  recordRunFinished(status: "succeeded" | "failed" | "interrupted" | "cancelled"): void {
    if (this.activeRunsCount > 0) {
      this.activeRunsCount--;
    }
    if (status === "succeeded") {
      this.totals.runsSucceeded++;
    } else {
      this.totals.runsFailed++;
    }
  }

  recordRetry(): void {
    this.totals.retries++;
  }

  recordRateLimited(): void {
    this.totals.rateLimited++;
  }

  recordRunMetrics(jobName: string, metrics: {
    discovered: number;
    processed: number;
    succeeded: number;
    unchanged: number;
    failed: number;
    retries?: number;
    rateLimited?: number;
    durationMs: number;
    runState: string;
  }): void {
    const retries = metrics.retries ?? 0;
    const rateLimited = metrics.rateLimited ?? 0;
    const throughput =
      metrics.durationMs > 0 ? (metrics.processed / (metrics.durationMs / 1000)) : 0;

    const existing = this.jobMetrics.get(jobName);
    const updated: JobMetricsSnapshot = {
      jobName,
      counters: {
        discovered: (existing?.counters.discovered ?? 0) + metrics.discovered,
        processed: (existing?.counters.processed ?? 0) + metrics.processed,
        succeeded: (existing?.counters.succeeded ?? 0) + metrics.succeeded,
        unchanged: (existing?.counters.unchanged ?? 0) + metrics.unchanged,
        failed: (existing?.counters.failed ?? 0) + metrics.failed,
        retries: (existing?.counters.retries ?? 0) + retries,
        rateLimited: (existing?.counters.rateLimited ?? 0) + rateLimited,
      },
      durationMs: metrics.durationMs,
      throughputPerSecond: Math.round(throughput * 100) / 100,
      lastRunState: metrics.runState,
      lastRunFinishedAt: new Date().toISOString(),
    };

    this.jobMetrics.set(jobName, updated);

    // Update global totals
    this.totals.discovered += metrics.discovered;
    this.totals.processed += metrics.processed;
    this.totals.succeeded += metrics.succeeded;
    this.totals.unchanged += metrics.unchanged;
    this.totals.failed += metrics.failed;
    this.totals.retries += retries;
    this.totals.rateLimited += rateLimited;
  }

  getSnapshot(): SystemMetricsSnapshot {
    const jobs: Record<string, JobMetricsSnapshot> = {};
    for (const [name, snapshot] of this.jobMetrics.entries()) {
      jobs[name] = { ...snapshot, counters: { ...snapshot.counters } };
    }

    return {
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      activeRuns: this.activeRunsCount,
      jobs,
      totals: { ...this.totals },
    };
  }

  toPrometheus(): string {
    const lines: string[] = [
      "# HELP syncsuite_uptime_seconds Total runtime of the syncsuite instance in seconds",
      "# TYPE syncsuite_uptime_seconds gauge",
      `syncsuite_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`,
      "",
      "# HELP syncsuite_active_runs Number of runs currently executing",
      "# TYPE syncsuite_active_runs gauge",
      `syncsuite_active_runs ${this.activeRunsCount}`,
      "",
      "# HELP syncsuite_records_discovered_total Cumulative count of records discovered",
      "# TYPE syncsuite_records_discovered_total counter",
      `syncsuite_records_discovered_total ${this.totals.discovered}`,
      "",
      "# HELP syncsuite_records_processed_total Cumulative count of records processed",
      "# TYPE syncsuite_records_processed_total counter",
      `syncsuite_records_processed_total ${this.totals.processed}`,
      "",
      "# HELP syncsuite_records_succeeded_total Cumulative count of records written or reconciled successfully",
      "# TYPE syncsuite_records_succeeded_total counter",
      `syncsuite_records_succeeded_total ${this.totals.succeeded}`,
      "",
      "# HELP syncsuite_records_unchanged_total Cumulative count of records skipped as unchanged",
      "# TYPE syncsuite_records_unchanged_total counter",
      `syncsuite_records_unchanged_total ${this.totals.unchanged}`,
      "",
      "# HELP syncsuite_records_failed_total Cumulative count of records failed",
      "# TYPE syncsuite_records_failed_total counter",
      `syncsuite_records_failed_total ${this.totals.failed}`,
      "",
      "# HELP syncsuite_retries_total Cumulative count of retry attempts",
      "# TYPE syncsuite_retries_total counter",
      `syncsuite_retries_total ${this.totals.retries}`,
      "",
      "# HELP syncsuite_rate_limit_events_total Cumulative count of rate limit backoff events",
      "# TYPE syncsuite_rate_limit_events_total counter",
      `syncsuite_rate_limit_events_total ${this.totals.rateLimited}`,
      "",
      "# HELP syncsuite_runs_total Total count of job executions",
      "# TYPE syncsuite_runs_total counter",
      `syncsuite_runs_total{status="succeeded"} ${this.totals.runsSucceeded}`,
      `syncsuite_runs_total{status="failed"} ${this.totals.runsFailed}`,
    ];

    for (const [job, s] of this.jobMetrics.entries()) {
      const sanitizedJob = job.replace(/["\\]/g, "");
      lines.push(
        "",
        `syncsuite_job_records_processed_total{job="${sanitizedJob}"} ${s.counters.processed}`,
        `syncsuite_job_records_succeeded_total{job="${sanitizedJob}"} ${s.counters.succeeded}`,
        `syncsuite_job_records_failed_total{job="${sanitizedJob}"} ${s.counters.failed}`,
        `syncsuite_job_last_throughput_records_per_sec{job="${sanitizedJob}"} ${s.throughputPerSecond}`,
      );
    }

    return lines.join("\n") + "\n";
  }
}

export const defaultMetrics = new MetricsRegistry();
