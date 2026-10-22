import type { Pool, PoolClient } from "pg";
import { DuplicateJobError, JobNotFoundError, LeaseLostError } from "../core/errors.js";
import { canonicalJson } from "../core/idempotency.js";
import { parseJobSpec } from "../core/job-spec.js";
import type { JobSpec } from "../core/job-spec.js";
import { emptyCounters } from "../core/types.js";
import type {
  Checkpoint,
  CheckpointStore,
  Cursor,
  EventLevel,
  LedgerEntry,
  RunCounters,
  RunError,
  RunState,
  RunTrigger,
} from "../core/types.js";
import { migrate } from "./migrations.js";

export interface Job {
  id: string;
  name: string;
  spec: JobSpec;
  specVersion: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Run {
  id: string;
  jobId: string;
  state: RunState;
  trigger: RunTrigger;
  dryRun: boolean;
  epoch: bigint | null;
  startedAt: Date;
  finishedAt: Date | null;
  counters: RunCounters;
  error: RunError | null;
}

export interface DeadLetter {
  id: string;
  jobId: string;
  runId: string | null;
  recordKey: string;
  payload: unknown;
  errorKind: string;
  error: unknown;
  attempts: number;
  state: "open" | "retrying" | "resolved";
  firstFailedAt: Date;
  lastAttemptAt: Date;
}

export interface RunEvent {
  id: number;
  runId: string;
  ts: Date;
  level: EventLevel;
  event: string;
  data: Record<string, unknown>;
}

// Row shapes are type aliases, not interfaces: pg's query generic requires an
// index signature, which interfaces do not get implicitly.
type JobRow = { id: string; name: string; spec: unknown; spec_version: number; enabled: boolean; created_at: Date; updated_at: Date };
type RunRow = {
  id: string; job_id: string; state: RunState; trigger: RunTrigger; dry_run: boolean; epoch: string | null;
  started_at: Date; finished_at: Date | null; counters: Partial<RunCounters>; error: RunError | null;
};
type DeadLetterRow = {
  id: string; job_id: string; run_id: string | null; record_key: string; payload: unknown; error_kind: string;
  error: unknown; attempts: number; state: DeadLetter["state"]; first_failed_at: Date; last_attempt_at: Date;
};
type EventRow = { id: string; run_id: string; ts: Date; level: EventLevel; event: string; data: Record<string, unknown> };

const toJob = (r: JobRow): Job => ({
  id: r.id, name: r.name, spec: parseJobSpec(r.spec), specVersion: r.spec_version,
  enabled: r.enabled, createdAt: r.created_at, updatedAt: r.updated_at,
});

const toRun = (r: RunRow): Run => ({
  id: r.id, jobId: r.job_id, state: r.state, trigger: r.trigger, dryRun: r.dry_run,
  epoch: r.epoch === null ? null : BigInt(r.epoch), startedAt: r.started_at, finishedAt: r.finished_at,
  counters: { ...emptyCounters(), ...r.counters }, error: r.error,
});

const toDeadLetter = (r: DeadLetterRow): DeadLetter => ({
  id: r.id, jobId: r.job_id, runId: r.run_id, recordKey: r.record_key, payload: r.payload,
  errorKind: r.error_kind, error: r.error, attempts: r.attempts, state: r.state,
  firstFailedAt: r.first_failed_at, lastAttemptAt: r.last_attempt_at,
});

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

function first<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected a row but the query returned none");
  return row;
}

export class StateStore implements CheckpointStore {
  readonly schema: string;
  private readonly q: string;

  constructor(
    private readonly pool: Pool,
    options: { schema?: string } = {},
  ) {
    const schema = options.schema ?? "synckit";
    // The schema name is interpolated into SQL, so it is restricted to a safe
    // identifier alphabet instead of being escaped.
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`invalid schema name '${schema}'`);
    this.schema = schema;
    this.q = `"${schema}"`;
  }

  migrate(): Promise<number[]> {
    return migrate(this.pool, this.schema);
  }

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async createJob(spec: JobSpec): Promise<Job> {
    try {
      return await this.tx(async (c) => {
        const res = await c.query<JobRow>(
          `INSERT INTO ${this.q}.jobs (name, spec) VALUES ($1, $2::jsonb) RETURNING *`,
          [spec.name, JSON.stringify(spec)],
        );
        const row = first(res.rows);
        await c.query(`INSERT INTO ${this.q}.leases (job_id) VALUES ($1)`, [row.id]);
        return toJob(row);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateJobError(spec.name);
      throw err;
    }
  }

  async getJob(id: string): Promise<Job | null> {
    const res = await this.pool.query<JobRow>(`SELECT * FROM ${this.q}.jobs WHERE id = $1`, [id]);
    const row = res.rows[0];
    return row ? toJob(row) : null;
  }

  async getJobByName(name: string): Promise<Job | null> {
    const res = await this.pool.query<JobRow>(`SELECT * FROM ${this.q}.jobs WHERE name = $1`, [name]);
    const row = res.rows[0];
    return row ? toJob(row) : null;
  }

  async getJobByIdOrName(idOrName: string): Promise<Job | null> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrName);
    const res = isUuid
      ? await this.pool.query<JobRow>(`SELECT * FROM ${this.q}.jobs WHERE id = $1 OR name = $1`, [idOrName])
      : await this.pool.query<JobRow>(`SELECT * FROM ${this.q}.jobs WHERE name = $1`, [idOrName]);
    const row = res.rows[0];
    return row ? toJob(row) : null;
  }

  async updateJob(name: string, spec: JobSpec): Promise<Job> {
    const res = await this.pool.query<JobRow>(
      `UPDATE ${this.q}.jobs
          SET spec = $2::jsonb, spec_version = spec_version + 1, updated_at = now()
        WHERE name = $1
        RETURNING *`,
      [name, JSON.stringify(spec)],
    );
    const row = res.rows[0];
    if (!row) throw new JobNotFoundError(name);
    return toJob(row);
  }

  async upsertJob(spec: JobSpec): Promise<{ job: Job; created: boolean }> {
    return this.tx(async (c) => {
      const existing = await c.query<JobRow>(
        `SELECT * FROM ${this.q}.jobs WHERE name = $1 FOR UPDATE`,
        [spec.name],
      );
      if (existing.rows[0]) {
        const res = await c.query<JobRow>(
          `UPDATE ${this.q}.jobs
              SET spec = $2::jsonb, spec_version = spec_version + 1, updated_at = now()
            WHERE id = $1
            RETURNING *`,
          [existing.rows[0].id, JSON.stringify(spec)],
        );
        return { job: toJob(first(res.rows)), created: false };
      }

      const res = await c.query<JobRow>(
        `INSERT INTO ${this.q}.jobs (name, spec) VALUES ($1, $2::jsonb) RETURNING *`,
        [spec.name, JSON.stringify(spec)],
      );
      const row = first(res.rows);
      await c.query(`INSERT INTO ${this.q}.leases (job_id) VALUES ($1)`, [row.id]);
      return { job: toJob(row), created: true };
    });
  }

  async deleteJob(nameOrId: string): Promise<boolean> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nameOrId);
    const query = isUuid
      ? `DELETE FROM ${this.q}.jobs WHERE id = $1 OR name = $1`
      : `DELETE FROM ${this.q}.jobs WHERE name = $1`;
    const res = await this.pool.query(query, [nameOrId]);
    return (res.rowCount ?? 0) > 0;
  }

  async listJobs(): Promise<Job[]> {
    const res = await this.pool.query<JobRow>(`SELECT * FROM ${this.q}.jobs ORDER BY name`);
    return res.rows.map(toJob);
  }

  // Lease expiry uses the database clock so workers with skewed clocks agree.
  // Returns the new epoch, or null if another worker holds an unexpired lease.
  async acquireLease(jobId: string, owner: string, ttlMs: number): Promise<bigint | null> {
    return this.tx(async (c) => {
      const res = await c.query<{ epoch: string }>(
        `UPDATE ${this.q}.leases
            SET owner = $2, epoch = epoch + 1, expires_at = now() + ($3::int * interval '1 millisecond')
          WHERE job_id = $1 AND (owner IS NULL OR expires_at < now())
          RETURNING epoch`,
        [jobId, owner, ttlMs],
      );
      const row = res.rows[0];
      if (!row) return null;
      // Only one non-dry run can legitimately be active per job, so any that is
      // still 'running' belongs to a worker whose lease we just took over.
      await c.query(
        `UPDATE ${this.q}.runs SET state = 'interrupted', finished_at = now()
          WHERE job_id = $1 AND state = 'running'`,
        [jobId],
      );
      return BigInt(row.epoch);
    });
  }

  async heartbeat(jobId: string, owner: string, epoch: bigint, ttlMs: number): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE ${this.q}.leases SET expires_at = now() + ($4::int * interval '1 millisecond')
        WHERE job_id = $1 AND owner = $2 AND epoch = $3`,
      [jobId, owner, epoch.toString(), ttlMs],
    );
    return res.rowCount === 1;
  }

  async releaseLease(jobId: string, epoch: bigint): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.q}.leases SET owner = NULL, expires_at = NULL WHERE job_id = $1 AND epoch = $2`,
      [jobId, epoch.toString()],
    );
  }

  async createRun(
    jobId: string,
    epoch: bigint | null,
    opts: { trigger: RunTrigger; dryRun: boolean; state?: RunState },
  ): Promise<Run> {
    const state = opts.state ?? (epoch === null ? "pending" : "running");
    const res = await this.pool.query<RunRow>(
      `INSERT INTO ${this.q}.runs (job_id, state, trigger, dry_run, epoch)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [jobId, state, opts.trigger, opts.dryRun, epoch === null ? null : epoch.toString()],
    );
    return toRun(first(res.rows));
  }

  async startPendingRun(runId: string, epoch: bigint): Promise<Run | null> {
    const res = await this.pool.query<RunRow>(
      `UPDATE ${this.q}.runs
          SET state = 'running', epoch = $2, started_at = now()
        WHERE id = $1 AND state = 'pending'
        RETURNING *`,
      [runId, epoch.toString()],
    );
    const row = res.rows[0];
    return row ? toRun(row) : null;
  }

  async getNextPendingRun(jobId?: string): Promise<Run | null> {
    let query = `SELECT * FROM ${this.q}.runs WHERE state = 'pending'`;
    const params: unknown[] = [];
    if (jobId) {
      params.push(jobId);
      query += ` AND job_id = $1`;
    }
    query += ` ORDER BY started_at ASC LIMIT 1`;
    const res = await this.pool.query<RunRow>(query, params);
    const row = res.rows[0];
    return row ? toRun(row) : null;
  }

  // Guarded on state = 'running' so a worker that lost its lease cannot
  // overwrite the 'interrupted' state assigned by its successor.
  async finishRun(runId: string, state: RunState, counters: RunCounters, error?: RunError): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE ${this.q}.runs
          SET state = $2, finished_at = now(), counters = $3::jsonb, error = $4::jsonb
        WHERE id = $1 AND state = 'running'`,
      [runId, state, JSON.stringify(counters), error ? JSON.stringify(error) : null],
    );
    return res.rowCount === 1;
  }

  async getRun(runId: string): Promise<Run | null> {
    const res = await this.pool.query<RunRow>(`SELECT * FROM ${this.q}.runs WHERE id = $1`, [runId]);
    const row = res.rows[0];
    return row ? toRun(row) : null;
  }

  async listRuns(jobId: string, limit = 50): Promise<Run[]> {
    const res = await this.pool.query<RunRow>(
      `SELECT * FROM ${this.q}.runs WHERE job_id = $1 ORDER BY started_at DESC, id LIMIT $2`,
      [jobId, limit],
    );
    return res.rows.map(toRun);
  }

  async load(jobId: string): Promise<Checkpoint | null> {
    const res = await this.pool.query<{ cursor: Cursor; epoch: string; run_id: string; committed_at: Date }>(
      `SELECT cursor, epoch, run_id, committed_at FROM ${this.q}.checkpoints WHERE job_id = $1`,
      [jobId],
    );
    const row = res.rows[0];
    return row ? { cursor: row.cursor, epoch: BigInt(row.epoch), runId: row.run_id, committedAt: row.committed_at } : null;
  }

  // Locking the lease row with FOR UPDATE serializes this commit against
  // acquireLease: a successor either acquires before we lock (epoch mismatch,
  // we fail) or waits until we commit. A stale worker therefore cannot move
  // the checkpoint after being replaced.
  async commit(jobId: string, epoch: bigint, runId: string, cursor: Cursor, counters?: RunCounters): Promise<void> {
    await this.tx(async (c) => {
      const lease = await c.query<{ epoch: string }>(
        `SELECT epoch FROM ${this.q}.leases WHERE job_id = $1 FOR UPDATE`,
        [jobId],
      );
      const row = lease.rows[0];
      if (!row || BigInt(row.epoch) !== epoch) throw new LeaseLostError(jobId);

      await c.query(
        `INSERT INTO ${this.q}.checkpoints (job_id, cursor, epoch, run_id)
         VALUES ($1, $2::jsonb, $3, $4)
         ON CONFLICT (job_id) DO UPDATE
           SET cursor = EXCLUDED.cursor, epoch = EXCLUDED.epoch, run_id = EXCLUDED.run_id, committed_at = now()`,
        [jobId, JSON.stringify(cursor), epoch.toString(), runId],
      );
      if (counters) {
        await c.query(`UPDATE ${this.q}.runs SET counters = $2::jsonb WHERE id = $1 AND state = 'running'`, [
          runId,
          JSON.stringify(counters),
        ]);
      }
    });
  }

  async insertDeadLetter(input: {
    jobId: string;
    runId: string;
    recordKey: string;
    payload: unknown;
    errorKind: string;
    error: unknown;
    attempts?: number;
  }): Promise<void> {
    const attempts = input.attempts ?? 1;
    // canonicalJson rather than JSON.stringify: payloads can hold Dates and
    // bigints from database sources, and bigint makes JSON.stringify throw.
    await this.pool.query(
      `INSERT INTO ${this.q}.dead_letters AS dl (job_id, run_id, record_key, payload, error_kind, error, attempts)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7)
       ON CONFLICT (job_id, record_key) WHERE state IN ('open','retrying')
       DO UPDATE SET run_id = EXCLUDED.run_id, payload = EXCLUDED.payload, error_kind = EXCLUDED.error_kind,
                     error = EXCLUDED.error, attempts = dl.attempts + EXCLUDED.attempts, last_attempt_at = now()`,
      [input.jobId, input.runId, input.recordKey, canonicalJson(input.payload), input.errorKind, canonicalJson(input.error), attempts],
    );
  }

  async listDeadLetters(jobId: string, opts: { state?: DeadLetter["state"]; limit?: number } = {}): Promise<DeadLetter[]> {
    const res = await this.pool.query<DeadLetterRow>(
      `SELECT * FROM ${this.q}.dead_letters
        WHERE job_id = $1 AND ($2::text IS NULL OR state = $2)
        ORDER BY first_failed_at, record_key LIMIT $3`,
      [jobId, opts.state ?? null, opts.limit ?? 100],
    );
    return res.rows.map(toDeadLetter);
  }

  async getLedgerEntry(jobId: string, recordKey: string): Promise<LedgerEntry | null> {
    const res = await this.pool.query<{ content_hash: string; delivered_at: Date }>(
      `SELECT content_hash, delivered_at FROM ${this.q}.delivery_ledger WHERE job_id = $1 AND record_key = $2`,
      [jobId, recordKey],
    );
    const row = res.rows[0];
    return row ? { contentHash: row.content_hash, deliveredAt: row.delivered_at } : null;
  }

  async getLedgerEntries(jobId: string, recordKeys: string[]): Promise<Map<string, string>> {
    if (recordKeys.length === 0) return new Map();
    const res = await this.pool.query<{ record_key: string; content_hash: string }>(
      `SELECT record_key, content_hash FROM ${this.q}.delivery_ledger WHERE job_id = $1 AND record_key = ANY($2::text[])`,
      [jobId, recordKeys],
    );
    const map = new Map<string, string>();
    for (const row of res.rows) {
      map.set(row.record_key, row.content_hash);
    }
    return map;
  }

  async upsertLedger(jobId: string, recordKey: string, contentHash: string, runId?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.q}.delivery_ledger (job_id, record_key, content_hash, run_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (job_id, record_key)
       DO UPDATE SET content_hash = EXCLUDED.content_hash, run_id = EXCLUDED.run_id, delivered_at = now()`,
      [jobId, recordKey, contentHash, runId ?? null],
    );
  }

  async getDeadLetter(id: string): Promise<DeadLetter | null> {
    const res = await this.pool.query<DeadLetterRow>(`SELECT * FROM ${this.q}.dead_letters WHERE id = $1`, [id]);
    const row = res.rows[0];
    return row ? toDeadLetter(row) : null;
  }

  async updateDeadLetter(
    id: string,
    update: { state: DeadLetter["state"]; error?: unknown; attempts?: number; runId?: string },
  ): Promise<boolean> {
    const sets: string[] = ["state = $2", "last_attempt_at = now()"];
    const params: unknown[] = [id, update.state];
    if (update.error !== undefined) {
      params.push(canonicalJson(update.error));
      sets.push(`error = $${params.length}::jsonb`);
    }
    if (update.attempts !== undefined) {
      params.push(update.attempts);
      sets.push(`attempts = $${params.length}`);
    }
    if (update.runId !== undefined) {
      params.push(update.runId);
      sets.push(`run_id = $${params.length}`);
    }
    const res = await this.pool.query(`UPDATE ${this.q}.dead_letters SET ${sets.join(", ")} WHERE id = $1`, params);
    return res.rowCount === 1;
  }

  async markDeadLettersRetrying(jobId: string, ids?: string[]): Promise<DeadLetter[]> {
    let query = `UPDATE ${this.q}.dead_letters SET state = 'retrying', last_attempt_at = now() WHERE job_id = $1 AND state = 'open'`;
    const params: unknown[] = [jobId];
    if (ids && ids.length > 0) {
      params.push(ids);
      query += ` AND id = ANY($2::uuid[])`;
    }
    query += ` RETURNING *`;
    const res = await this.pool.query<DeadLetterRow>(query, params);
    return res.rows.map(toDeadLetter);
  }

  async resolveDeadLetter(id: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE ${this.q}.dead_letters SET state = 'resolved', last_attempt_at = now() WHERE id = $1`,
      [id],
    );
    return res.rowCount === 1;
  }

  async insertEvent(runId: string, level: EventLevel, event: string, data: Record<string, unknown> = {}): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.q}.run_events (run_id, level, event, data) VALUES ($1, $2, $3, $4::jsonb)`,
      [runId, level, event, canonicalJson(data)],
    );
  }

  async listEvents(runId: string, limit = 500): Promise<RunEvent[]> {
    const res = await this.pool.query<EventRow>(
      `SELECT * FROM ${this.q}.run_events WHERE run_id = $1 ORDER BY id LIMIT $2`,
      [runId, limit],
    );
    return res.rows.map((r) => ({ id: Number(r.id), runId: r.run_id, ts: r.ts, level: r.level, event: r.event, data: r.data }));
  }

  /**
   * Sweeps runs that remain in 'running' state after their lease has expired,
   * transitioning them to 'interrupted' and releasing any orphaned lease.
   */
  async sweepStuckRuns(): Promise<number> {
    return this.tx(async (c) => {
      // Find jobs whose leases have expired while a run is still marked 'running'
      const res = await c.query(
        `UPDATE ${this.q}.runs r
            SET state = 'interrupted', finished_at = now()
           FROM ${this.q}.leases l
          WHERE r.job_id = l.job_id
            AND r.state = 'running'
            AND (l.expires_at IS NOT NULL AND l.expires_at < now())`,
      );

      // Clean up orphaned lease holders
      await c.query(
        `UPDATE ${this.q}.leases
            SET owner = NULL, expires_at = NULL
          WHERE expires_at IS NOT NULL AND expires_at < now()`,
      );

      return res.rowCount ?? 0;
    });
  }

  /**
   * Prunes completed or terminal runs older than the specified retention period (in days).
   */
  async pruneRuns(olderThanDays: number): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM ${this.q}.runs
        WHERE state IN ('succeeded', 'failed', 'interrupted', 'cancelled')
          AND started_at < now() - ($1::int * interval '1 day')`,
      [olderThanDays],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Prunes run events older than the specified retention period (in days).
   */
  async pruneEvents(olderThanDays: number): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM ${this.q}.run_events
        WHERE ts < now() - ($1::int * interval '1 day')`,
      [olderThanDays],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Prunes resolved dead letter records older than the specified retention period (in days).
   */
  async pruneResolvedDeadLetters(olderThanDays: number): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM ${this.q}.dead_letters
        WHERE state = 'resolved'
          AND last_attempt_at < now() - ($1::int * interval '1 day')`,
      [olderThanDays],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Prunes delivery ledger entries older than the specified retention period (in days).
   */
  async pruneDeliveryLedger(olderThanDays: number): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM ${this.q}.delivery_ledger
        WHERE updated_at < now() - ($1::int * interval '1 day')`,
      [olderThanDays],
    );
    return res.rowCount ?? 0;
  }
}

