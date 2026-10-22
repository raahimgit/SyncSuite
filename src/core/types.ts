export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

// Opaque to the engine. Only the connector that produced a cursor may interpret it.
export type Cursor = { readonly [key: string]: JsonValue };

export type RecordData = Record<string, unknown>;

export interface SourceRecord {
  // Stable identity of the record in the source. Used for the delivery ledger,
  // so it must not change when the record's content changes.
  key: string;
  data: RecordData;
}

export interface ReadBatch {
  records: SourceRecord[];
  // Cursor of the last record in `records`. Null only when `records` is empty.
  nextCursor: Cursor | null;
}

export interface SourceConnector {
  readonly type: string;
  open(signal: AbortSignal): Promise<void>;
  readBatch(from: Cursor | null, limit: number, signal: AbortSignal): Promise<ReadBatch>;
  // Must be safe to call even if open() failed or was never called.
  close(): Promise<void>;
}

export interface WriteRequest {
  key: string;
  idempotencyKey: string;
  data: RecordData;
}

export type WriteResult = { status: "written" } | { status: "unchanged" };

export interface PlannedWrite {
  action: "create" | "update" | "unchanged" | "unknown";
  // Must already be redacted: never includes credentials or auth headers.
  description: string;
}

export interface DestinationConnector {
  readonly type: string;
  open(signal: AbortSignal): Promise<void>;
  write(req: WriteRequest, signal: AbortSignal): Promise<WriteResult>;
  plan?(req: WriteRequest, signal: AbortSignal): Promise<PlannedWrite>;
  close(): Promise<void>;
}

export interface Checkpoint {
  cursor: Cursor;
  epoch: bigint;
  runId: string;
  committedAt: Date;
}

export interface CheckpointStore {
  load(jobId: string): Promise<Checkpoint | null>;
  // Must reject if `epoch` is not the job's current lease epoch (fencing).
  // Counters, when given, are persisted in the same transaction as the cursor
  // so the stored progress and the stored cursor can never disagree.
  commit(jobId: string, epoch: bigint, runId: string, cursor: Cursor, counters?: RunCounters): Promise<void>;
}

export type RunState = "pending" | "running" | "succeeded" | "partial" | "failed" | "cancelled" | "interrupted";
export type RunTrigger = "manual" | "schedule" | "retry";
export type EventLevel = "debug" | "info" | "warn" | "error";

export interface RunError {
  // An ErrorKind, or "unclassified" for exceptions that were not a SyncError.
  kind: string;
  message: string;
}

export interface RunCounters {
  discovered: number;
  processed: number;
  succeeded: number;
  unchanged: number;
  planned: number;
  failed: number;
  retries: number;
  batches: number;
  rateLimitWaits: number;
  rateLimitWaitMsTotal: number;
  rateLimitedResponses: number;
}

export function emptyCounters(): RunCounters {
  return {
    discovered: 0,
    processed: 0,
    succeeded: 0,
    unchanged: 0,
    planned: 0,
    failed: 0,
    retries: 0,
    batches: 0,
    rateLimitWaits: 0,
    rateLimitWaitMsTotal: 0,
    rateLimitedResponses: 0,
  };
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export type Rng = () => number;

export const defaultClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
      const timer = setTimeout(resolve, ms);
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error("aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }),
};

export interface LedgerEntry {
  contentHash: string;
  deliveredAt: Date;
}

export type Transformer = (record: RecordData) => RecordData;

export interface ValidationIssue {
  path: string;
  rule: string;
  message: string;
}

export type ValidationResult = { ok: true } | { ok: false; issues: ValidationIssue[] };

export interface Validator {
  validate(record: RecordData): ValidationResult;
}

export type ErrorKind = "transient" | "rate_limited" | "permanent" | "fatal";

export class SyncError extends Error {
  readonly kind: ErrorKind;
  // Server-requested delay (Retry-After). Only meaningful for rate_limited/transient.
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: ErrorKind,
    message: string,
    options: { cause?: unknown; retryAfterMs?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SyncError";
    this.kind = kind;
    this.retryAfterMs = options.retryAfterMs;
  }
}
