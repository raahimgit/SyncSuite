import type { Pool } from "pg";

interface Migration {
  id: number;
  name: string;
  // `q` is the already-quoted schema identifier. Callers validate the schema
  // name before it gets here; it is never user-supplied at run time.
  sql: (q: string) => string;
}

// Requires PostgreSQL 13+ for gen_random_uuid() without an extension.
const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "initial",
    sql: (q) => `
      CREATE TABLE ${q}.jobs (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name        text NOT NULL UNIQUE,
        spec        jsonb NOT NULL,
        spec_version int NOT NULL DEFAULT 1,
        enabled     boolean NOT NULL DEFAULT true,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );

      -- One row per job. epoch increases on every successful acquisition and is
      -- the fencing token: writes carrying an older epoch are rejected.
      CREATE TABLE ${q}.leases (
        job_id     uuid PRIMARY KEY REFERENCES ${q}.jobs(id) ON DELETE CASCADE,
        owner      text,
        epoch      bigint NOT NULL DEFAULT 0,
        expires_at timestamptz
      );

      CREATE TABLE ${q}.runs (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id      uuid NOT NULL REFERENCES ${q}.jobs(id) ON DELETE CASCADE,
        state       text NOT NULL CHECK (state IN
                      ('pending','running','succeeded','partial','failed','cancelled','interrupted')),
        trigger     text NOT NULL CHECK (trigger IN ('manual','schedule','retry')),
        dry_run     boolean NOT NULL DEFAULT false,
        epoch       bigint,
        started_at  timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        counters    jsonb NOT NULL DEFAULT '{}',
        error       jsonb
      );
      CREATE INDEX runs_job_started_idx ON ${q}.runs (job_id, started_at DESC);

      -- run_id is deliberately not a foreign key: pruning old runs must never
      -- delete or block the checkpoint.
      CREATE TABLE ${q}.checkpoints (
        job_id       uuid PRIMARY KEY REFERENCES ${q}.jobs(id) ON DELETE CASCADE,
        cursor       jsonb NOT NULL,
        epoch        bigint NOT NULL,
        run_id       uuid NOT NULL,
        committed_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE ${q}.delivery_ledger (
        job_id       uuid NOT NULL REFERENCES ${q}.jobs(id) ON DELETE CASCADE,
        record_key   text NOT NULL,
        content_hash text NOT NULL,
        run_id       uuid,
        delivered_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (job_id, record_key)
      );

      CREATE TABLE ${q}.dead_letters (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id          uuid NOT NULL REFERENCES ${q}.jobs(id) ON DELETE CASCADE,
        run_id          uuid,
        record_key      text NOT NULL,
        payload         jsonb NOT NULL,
        error_kind      text NOT NULL,
        error           jsonb NOT NULL,
        attempts        int NOT NULL DEFAULT 1,
        state           text NOT NULL DEFAULT 'open' CHECK (state IN ('open','retrying','resolved')),
        first_failed_at timestamptz NOT NULL DEFAULT now(),
        last_attempt_at timestamptz NOT NULL DEFAULT now()
      );
      -- A record that keeps failing updates its open dead letter rather than
      -- piling up one row per run.
      CREATE UNIQUE INDEX dead_letters_open_key_idx
        ON ${q}.dead_letters (job_id, record_key) WHERE state IN ('open','retrying');
      CREATE INDEX dead_letters_job_state_idx ON ${q}.dead_letters (job_id, state);

      CREATE TABLE ${q}.run_events (
        id     bigserial PRIMARY KEY,
        run_id uuid NOT NULL REFERENCES ${q}.runs(id) ON DELETE CASCADE,
        ts     timestamptz NOT NULL DEFAULT now(),
        level  text NOT NULL CHECK (level IN ('debug','info','warn','error')),
        event  text NOT NULL,
        data   jsonb NOT NULL DEFAULT '{}'
      );
      CREATE INDEX run_events_run_idx ON ${q}.run_events (run_id, id);
    `,
  },
];

// Runs pending migrations in one transaction under an advisory lock, so two
// processes starting at once cannot both apply the same migration. Returns the
// ids of migrations applied by this call.
export async function migrate(pool: Pool, schema: string): Promise<number[]> {
  const q = `"${schema}"`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`syncsuite:${schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${q}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${q}.schema_migrations (
         id int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = await client.query<{ id: number }>(`SELECT id FROM ${q}.schema_migrations`);
    const applied = new Set(done.rows.map((r) => r.id));

    const ran: number[] = [];
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      await client.query(m.sql(q));
      await client.query(`INSERT INTO ${q}.schema_migrations (id, name) VALUES ($1, $2)`, [m.id, m.name]);
      ran.push(m.id);
    }
    await client.query("COMMIT");
    return ran;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
