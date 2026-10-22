import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Job, StateStore } from "../db/store.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { mapConcurrent } from "./concurrency.js";
import { JobBusyError, JobDisabledError, JobNotFoundError, LeaseLostError } from "./errors.js";
import { contentHash, idempotencyKey } from "./idempotency.js";
import { nullLogger, RedactionFilter } from "./logger.js";
import type { Logger } from "./logger.js";
import { TokenBucketRateLimiter } from "./rate-limiter.js";
import type { ConnectorRegistry } from "./registry.js";
import { executeWithRetry } from "./retry.js";
import { compileTransform } from "./transform.js";
import { SyncError, defaultClock, emptyCounters } from "./types.js";
import type {
  Clock,
  Cursor,
  DestinationConnector,
  ErrorKind,
  EventLevel,
  PlannedWrite,
  RecordData,
  Rng,
  RunCounters,
  RunError,
  RunState,
  RunTrigger,
  SourceRecord,
  Transformer,
  ValidationIssue,
  Validator,
} from "./types.js";
import { createValidator } from "./validator.js";

const DEFAULT_DRY_RUN_LIMIT = 100;

export interface RunnerOptions {
  store: StateStore;
  registry: ConnectorRegistry;
  logger?: Logger;
  owner?: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  clock?: Clock;
  rng?: Rng;
  redactDeadLetterPayload?: boolean;
}

export interface RunOptions {
  trigger?: RunTrigger;
  dryRun?: boolean;
  // Stop after reading this many records. Dry runs default to 100 so a report
  // over a large source stays bounded.
  maxRecords?: number;
  signal?: AbortSignal;
  runId?: string;
}

export interface RetryRunOptions {
  ids?: string[];
  limit?: number;
  signal?: AbortSignal;
}

export interface DryRunEntry {
  key: string;
  outcome: "would_write" | "invalid" | "transform_failed";
  plan?: PlannedWrite;
  issues?: ValidationIssue[];
  message?: string;
}

export interface RunResult {
  runId: string;
  state: RunState;
  counters: RunCounters;
  error?: RunError;
  dryRun?: DryRunEntry[];
}

interface RecordContext {
  job: Job;
  runId: string;
  signal: AbortSignal;
  dryRun: boolean;
  counters: RunCounters;
  transform: Transformer;
  validator: Validator;
  destination: DestinationConnector;
  rateLimiter?: TokenBucketRateLimiter;
  circuitBreaker: CircuitBreaker;
}

type Stage = "transform" | "validate" | "write";

function describeError(err: unknown): RunError {
  if (err instanceof SyncError) return { kind: err.kind, message: err.message };
  if (err instanceof Error) return { kind: "unclassified", message: err.message };
  return { kind: "unclassified", message: "a non-Error value was thrown" };
}

export class JobRunner {
  private readonly store: StateStore;
  private readonly registry: ConnectorRegistry;
  private readonly logger: Logger;
  private readonly owner: string;
  private readonly leaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly redactDeadLetterPayload: boolean;

  constructor(options: RunnerOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.logger = options.logger ?? nullLogger;
    this.owner = options.owner ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.floor(this.leaseTtlMs / 3);
    this.clock = options.clock ?? defaultClock;
    this.rng = options.rng ?? Math.random;
    this.redactDeadLetterPayload = options.redactDeadLetterPayload ?? false;
  }

  // Resolves with a RunResult for every outcome that happened inside a run
  // (succeeded, partial, failed, cancelled). Rejects only when no run could
  // proceed: unknown or disabled job, a job already running, or a lost lease.
  async run(jobName: string, options: RunOptions = {}): Promise<RunResult> {
    const job = await this.store.getJobByName(jobName);
    if (!job) throw new JobNotFoundError(jobName);
    if (!job.enabled) throw new JobDisabledError(jobName);

    const epoch = await this.store.acquireLease(job.id, this.owner, this.leaseTtlMs);
    if (epoch === null) throw new JobBusyError(jobName);

    const dryRun = options.dryRun ?? false;
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    const counters = emptyCounters();
    const entries: DryRunEntry[] = [];
    let runId: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let state: RunState = "failed";
    let error: RunError | undefined;
    let leaseLost = false;

    try {
      if (options.runId) {
        const started = await this.store.startPendingRun(options.runId, epoch);
        if (!started) {
          const existing = await this.store.getRun(options.runId);
          if (!existing) throw new Error(`run not found: ${options.runId}`);
        }
        runId = options.runId;
      } else {
        const run = await this.store.createRun(job.id, epoch, { trigger: options.trigger ?? "manual", dryRun });
        runId = run.id;
      }
      const id = runId;

      timer = setInterval(() => {
        this.store
          .heartbeat(job.id, this.owner, epoch, this.leaseTtlMs)
          .then((ok) => {
            if (!ok) controller.abort(new LeaseLostError(job.name));
          })
          .catch((err: unknown) => {
            // A failed heartbeat is not proof the lease is lost. Fencing on the
            // checkpoint commit is what actually protects correctness.
            this.logger.warn("lease.heartbeat_failed", { runId: id, error: describeError(err).message });
          });
      }, this.heartbeatIntervalMs);
      timer.unref();

      await this.emit(id, "info", "run.started", { job: job.name, dryRun, epoch: epoch.toString() });

      try {
        const completed = await this.execute(job, id, epoch, controller.signal, options, counters, entries);
        if (completed) state = counters.failed > 0 ? "partial" : "succeeded";
        else if (controller.signal.reason instanceof LeaseLostError) leaseLost = true;
        else state = "cancelled";
      } catch (err) {
        if (err instanceof LeaseLostError || controller.signal.reason instanceof LeaseLostError) leaseLost = true;
        else if (controller.signal.aborted) state = "cancelled";
        else {
          state = "failed";
          error = describeError(err);
        }
      }

      if (!leaseLost) {
        await this.emit(id, error ? "error" : "info", "run.finished", { state, ...(error ? { error } : {}) });
      }
    } finally {
      if (timer) clearInterval(timer);
      options.signal?.removeEventListener("abort", onAbort);
      // Finish the run before releasing the lease. The next acquirer marks any
      // run still 'running' as interrupted, so releasing first would let it
      // mislabel a run that actually completed.
      if (runId !== undefined && !leaseLost) {
        await this.store.finishRun(runId, state, counters, error);
      }
      await this.store.releaseLease(job.id, epoch).catch((err: unknown) => {
        this.logger.warn("lease.release_failed", { error: describeError(err).message });
      });
    }

    if (leaseLost) throw new LeaseLostError(job.name);
    return { runId: runId as string, state, counters, ...(error ? { error } : {}), ...(dryRun ? { dryRun: entries } : {}) };
  }

  // Returns true when the source was exhausted (or maxRecords reached) and
  // false when stopped early by the abort signal.
  private async execute(
    job: Job,
    runId: string,
    epoch: bigint,
    signal: AbortSignal,
    options: RunOptions,
    counters: RunCounters,
    entries: DryRunEntry[],
  ): Promise<boolean> {
    const spec = job.spec;
    const dryRun = options.dryRun ?? false;
    const source = this.registry.createSource(spec.source.type, spec.source.config);
    const destination = this.registry.createDestination(spec.destination.type, spec.destination.config);

    const rateLimiter = spec.rateLimit
      ? new TokenBucketRateLimiter({
          requestsPerSecond: spec.rateLimit.requestsPerSecond,
          burst: spec.rateLimit.burst,
          clock: this.clock,
        })
      : undefined;

    const circuitBreaker = new CircuitBreaker({
      maxConsecutiveFailures: spec.circuitBreaker.maxConsecutiveFailures,
    });

    const ctx: RecordContext = {
      job,
      runId,
      signal,
      dryRun,
      counters,
      transform: compileTransform(spec.transform),
      validator: createValidator(spec.validation),
      destination,
      rateLimiter,
      circuitBreaker,
    };

    try {
      await source.open(signal);
      await destination.open(signal);

      const checkpoint = await this.store.load(job.id);
      let cursor: Cursor | null = checkpoint?.cursor ?? null;
      const maxRecords = options.maxRecords ?? (dryRun ? DEFAULT_DRY_RUN_LIMIT : Number.POSITIVE_INFINITY);

      while (!signal.aborted) {
        const remaining = maxRecords - counters.discovered;
        if (remaining <= 0) return true;

        // Source read with retry policy and backoff
        const retryResult = await executeWithRetry(
          () => source.readBatch(cursor, Math.min(spec.batchSize, remaining), signal),
          spec.retry,
          {
            signal,
            clock: this.clock,
            rng: this.rng,
            onRetry: (err, retryCount, delayMs) => {
              counters.retries += 1;
              this.emit(runId, "warn", "source.retry", {
                retry: retryCount,
                delayMs,
                error: describeError(err).message,
              });
            },
          },
        );

        const batch = retryResult.result;
        if (batch.records.length === 0) return true;
        if (batch.nextCursor === null) {
          throw new SyncError("fatal", `source '${source.type}' returned records without a nextCursor`);
        }

        const prevCursor = cursor;
        const isSameCursor =
          prevCursor !== null &&
          Object.keys(prevCursor).length === Object.keys(batch.nextCursor).length &&
          Object.keys(prevCursor).every((k) => prevCursor[k] === batch.nextCursor![k]);

        if (isSameCursor) {
          throw new SyncError(
            "fatal",
            `source '${source.type}' cursor did not advance after reading batch (${batch.records.length} records); halting to prevent infinite loop`,
          );
        }

        counters.discovered += batch.records.length;
        counters.batches += 1;

        const results = await mapConcurrent(
          batch.records,
          spec.concurrency,
          (record) => this.processRecord(ctx, record),
          signal,
        );
        for (const entry of results) if (entry) entries.push(entry);

        // Batch barrier: every record above reached a terminal outcome, so the
        // cursor may move. Dry runs never persist progress.
        if (!dryRun) await this.store.commit(job.id, epoch, runId, batch.nextCursor, counters);
        cursor = batch.nextCursor;
        await this.emit(runId, "info", "batch.committed", { batch: counters.batches, records: batch.records.length, cursor });
      }
      return false;
    } finally {
      await Promise.allSettled([source.close(), destination.close()]);
    }
  }

  private async processRecord(ctx: RecordContext, record: SourceRecord): Promise<DryRunEntry | undefined> {
    let payload: RecordData;
    try {
      payload = ctx.transform(record.data);
    } catch (err) {
      if (err instanceof SyncError && err.kind === "permanent") {
        return this.failRecord(ctx, record, record.data, "transform", { message: err.message }, "permanent");
      }
      throw err;
    }

    const validation = ctx.validator.validate(payload);
    if (!validation.ok) {
      return this.failRecord(ctx, record, payload, "validate", { message: "validation failed", issues: validation.issues }, "permanent");
    }

    const hash = contentHash(payload);
    const request = {
      key: record.key,
      idempotencyKey: idempotencyKey(ctx.job.id, record.key, hash),
      data: payload,
    };

    if (ctx.dryRun) {
      const plan: PlannedWrite = ctx.destination.plan
        ? await ctx.destination.plan(request, ctx.signal)
        : { action: "unknown", description: "destination does not support planning" };
      ctx.counters.processed += 1;
      ctx.counters.planned += 1;
      return { key: record.key, outcome: "would_write", plan };
    }

    // Delivery ledger check: if record content hash matches previous delivery, skip writing!
    const ledgerEntry = await this.store.getLedgerEntry(ctx.job.id, record.key);
    if (ledgerEntry && ledgerEntry.contentHash === hash) {
      ctx.counters.processed += 1;
      ctx.counters.unchanged += 1;
      ctx.circuitBreaker.recordSuccess();
      await this.emit(ctx.runId, "debug", "record.skipped_unchanged", { key: record.key, hash });
      return undefined;
    }

    try {
      const retryResult = await executeWithRetry(
        async () => {
          if (ctx.rateLimiter) {
            const { waitedMs } = await ctx.rateLimiter.acquire(1, ctx.signal);
            if (waitedMs > 0) {
              ctx.counters.rateLimitWaits += 1;
              ctx.counters.rateLimitWaitMsTotal += waitedMs;
            }
          }
          return ctx.destination.write(request, ctx.signal);
        },
        ctx.job.spec.retry,
        {
          signal: ctx.signal,
          clock: this.clock,
          rng: this.rng,
          onRetry: (err, retryCount, delayMs) => {
            ctx.counters.retries += 1;
            if (err instanceof SyncError && err.kind === "rate_limited") {
              ctx.counters.rateLimitedResponses += 1;
              ctx.rateLimiter?.onRateLimited(err.retryAfterMs);
            }
            this.emit(ctx.runId, "warn", "destination.retry", {
              key: record.key,
              retry: retryCount,
              delayMs,
              error: describeError(err).message,
            });
          },
        },
      );

      ctx.counters.processed += 1;
      if (retryResult.result.status === "unchanged") ctx.counters.unchanged += 1;
      else ctx.counters.succeeded += 1;

      // Successful write resets the consecutive failures counter for the circuit breaker
      ctx.circuitBreaker.recordSuccess();

      // Upsert delivery ledger after successful write
      // Crash window note: If process crashes after destination.write succeeds
      // but before upsertLedger finishes, the record is re-sent on resume with the
      // same idempotencyKey. The destination absorbs the duplicate idempotently.
      await this.store.upsertLedger(ctx.job.id, record.key, hash, ctx.runId);

      return undefined;
    } catch (err) {
      // Permanent error is a statement about this record, not an outage
      if (err instanceof SyncError && err.kind === "permanent") {
        return this.failRecord(ctx, record, payload, "write", { message: err.message }, "permanent");
      }

      // Fatal error (auth, config, SSRF) immediately stops the run
      if (err instanceof SyncError && err.kind === "fatal") {
        throw err;
      }

      // Retries are exhausted on transient / rate_limited / unclassified error.
      // Record failure toward circuit breaker. If consecutive failures reach threshold,
      // recordRetryExhaustedFailure trips and throws a fatal SyncError, stopping the run
      // with the checkpoint untouched.
      ctx.circuitBreaker.recordRetryExhaustedFailure();

      // If circuit breaker did not trip, record this record as dead-lettered
      const kind: ErrorKind = err instanceof SyncError ? err.kind : "transient";
      return this.failRecord(
        ctx,
        record,
        payload,
        "write",
        { message: describeError(err).message },
        kind,
        ctx.job.spec.retry.maxAttempts,
      );
    }
  }

  private async failRecord(
    ctx: RecordContext,
    record: SourceRecord,
    payload: RecordData,
    stage: Stage,
    detail: { message: string; issues?: ValidationIssue[] },
    errorKind: ErrorKind = "permanent",
    attempts = 1,
  ): Promise<DryRunEntry | undefined> {
    ctx.counters.processed += 1;
    ctx.counters.failed += 1;

    if (ctx.dryRun) {
      return {
        key: record.key,
        outcome: stage === "transform" ? "transform_failed" : "invalid",
        message: detail.message,
        ...(detail.issues ? { issues: detail.issues } : {}),
      };
    }

    await this.persistDeadLetter(ctx, record, payload, stage, detail, errorKind, attempts);
    if (ctx.job.spec.onRecordFailure === "halt") {
      throw new SyncError("fatal", `record '${record.key}' failed at ${stage} and onRecordFailure is 'halt'`);
    }
    return undefined;
  }

  private async persistDeadLetter(
    ctx: RecordContext,
    record: SourceRecord,
    payload: RecordData,
    stage: Stage,
    detail: { message: string; issues?: ValidationIssue[] },
    errorKind: ErrorKind = "permanent",
    attempts = 1,
  ): Promise<void> {
    const finalPayload = this.redactDeadLetterPayload
      ? (new RedactionFilter().redactValue(payload) as RecordData)
      : payload;

    await this.store.insertDeadLetter({
      jobId: ctx.job.id,
      runId: ctx.runId,
      recordKey: record.key,
      payload: finalPayload,
      errorKind,
      error: { stage, ...detail },
      attempts,
    });
    await this.emit(ctx.runId, "warn", "record.dead_lettered", { key: record.key, stage, message: detail.message });
  }

  // Dead-letter re-drive path: reprocesses open dead letters independent of the cursor.
  // Transitions state: open -> retrying -> resolved (or back to open on terminal failure).
  async retry(jobName: string, options: RetryRunOptions = {}): Promise<RunResult> {
    const job = await this.store.getJobByName(jobName);
    if (!job) throw new JobNotFoundError(jobName);
    if (!job.enabled) throw new JobDisabledError(jobName);

    const epoch = await this.store.acquireLease(job.id, this.owner, this.leaseTtlMs);
    if (epoch === null) throw new JobBusyError(jobName);

    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    const counters = emptyCounters();
    let runId: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let state: RunState = "failed";
    let error: RunError | undefined;
    let leaseLost = false;

    try {
      const run = await this.store.createRun(job.id, epoch, { trigger: "retry", dryRun: false });
      runId = run.id;
      const id = run.id;

      timer = setInterval(() => {
        this.store
          .heartbeat(job.id, this.owner, epoch, this.leaseTtlMs)
          .then((ok) => {
            if (!ok) controller.abort(new LeaseLostError(job.name));
          })
          .catch((err: unknown) => {
            this.logger.warn("lease.heartbeat_failed", { runId: id, error: describeError(err).message });
          });
      }, this.heartbeatIntervalMs);
      timer.unref();

      await this.emit(id, "info", "retry.started", { job: job.name, epoch: epoch.toString() });

      const deadLetters = await this.store.markDeadLettersRetrying(job.id, options.ids);
      const toProcess = options.limit ? deadLetters.slice(0, options.limit) : deadLetters;
      counters.discovered = toProcess.length;

      const spec = job.spec;
      const destination = this.registry.createDestination(spec.destination.type, spec.destination.config);
      const transform = compileTransform(spec.transform);
      const validator = createValidator(spec.validation);
      const rateLimiter = spec.rateLimit
        ? new TokenBucketRateLimiter({
            requestsPerSecond: spec.rateLimit.requestsPerSecond,
            burst: spec.rateLimit.burst,
            clock: this.clock,
          })
        : undefined;

      try {
        await destination.open(controller.signal);

        for (const dl of toProcess) {
          if (controller.signal.aborted) break;

          let payload: RecordData;
          try {
            if (typeof dl.payload === "object" && dl.payload !== null) {
              payload = dl.payload as RecordData;
            } else {
              throw new SyncError("permanent", "invalid dead letter payload");
            }

            const errorObj = typeof dl.error === "object" && dl.error !== null ? (dl.error as Record<string, unknown>) : {};
            if (errorObj["stage"] === "transform") {
              payload = transform(payload);
            }
            if (errorObj["stage"] === "transform" || errorObj["stage"] === "validate") {
              const validation = validator.validate(payload);
              if (!validation.ok) {
                throw new SyncError("permanent", `validation failed: ${validation.issues.map((i) => i.message).join(", ")}`);
              }
            }

            const hash = contentHash(payload);
            const request = {
              key: dl.recordKey,
              idempotencyKey: idempotencyKey(job.id, dl.recordKey, hash),
              data: payload,
            };

            const retryResult = await executeWithRetry(
              async () => {
                if (rateLimiter) {
                  const { waitedMs } = await rateLimiter.acquire(1, controller.signal);
                  if (waitedMs > 0) {
                    counters.rateLimitWaits += 1;
                    counters.rateLimitWaitMsTotal += waitedMs;
                  }
                }
                return destination.write(request, controller.signal);
              },
              spec.retry,
              {
                signal: controller.signal,
                clock: this.clock,
                rng: this.rng,
                onRetry: (err, retryCount, delayMs) => {
                  counters.retries += 1;
                  if (err instanceof SyncError && err.kind === "rate_limited") {
                    counters.rateLimitedResponses += 1;
                    rateLimiter?.onRateLimited(err.retryAfterMs);
                  }
                  this.emit(id, "warn", "destination.retry", {
                    key: dl.recordKey,
                    retry: retryCount,
                    delayMs,
                    error: describeError(err).message,
                  });
                },
              },
            );

            counters.processed += 1;
            if (retryResult.result.status === "unchanged") counters.unchanged += 1;
            else counters.succeeded += 1;

            await this.store.resolveDeadLetter(dl.id);
            await this.store.upsertLedger(job.id, dl.recordKey, hash, id);
            await this.emit(id, "info", "dead_letter.resolved", { key: dl.recordKey });
          } catch (err) {
            counters.processed += 1;
            counters.failed += 1;
            await this.store.updateDeadLetter(dl.id, {
              state: "open",
              attempts: dl.attempts + 1,
              error: describeError(err),
              runId: id,
            });
            await this.emit(id, "warn", "dead_letter.retry_failed", { key: dl.recordKey, error: describeError(err).message });
          }
        }

        if (controller.signal.aborted) {
          if (controller.signal.reason instanceof LeaseLostError) leaseLost = true;
          else state = "cancelled";
        } else {
          state = counters.failed > 0 ? "partial" : "succeeded";
        }
      } finally {
        await destination.close().catch(() => undefined);
      }

      if (!leaseLost) {
        await this.emit(id, error ? "error" : "info", "retry.finished", { state, ...(error ? { error } : {}) });
      }
    } catch (err) {
      if (err instanceof LeaseLostError || controller.signal.reason instanceof LeaseLostError) leaseLost = true;
      else if (controller.signal.aborted) state = "cancelled";
      else {
        state = "failed";
        error = describeError(err);
      }
    } finally {
      if (timer) clearInterval(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (runId !== undefined && !leaseLost) {
        await this.store.finishRun(runId, state, counters, error);
      }
      await this.store.releaseLease(job.id, epoch).catch((err: unknown) => {
        this.logger.warn("lease.release_failed", { error: describeError(err).message });
      });
    }

    if (leaseLost) throw new LeaseLostError(job.name);
    return { runId: runId as string, state, counters, ...(error ? { error } : {}) };
  }

  // Events are diagnostics. Failing to persist one must not fail the run.
  private async emit(runId: string, level: EventLevel, event: string, data: Record<string, unknown> = {}): Promise<void> {
    this.logger[level](event, { runId, ...data });
    try {
      await this.store.insertEvent(runId, level, event, data);
    } catch (err) {
      this.logger.warn("event.persist_failed", { runId, event, error: describeError(err).message });
    }
  }
}
