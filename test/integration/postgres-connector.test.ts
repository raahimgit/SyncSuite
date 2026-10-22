import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDestination } from "../../src/connectors/postgres-destination.js";
import { PostgresSource } from "../../src/connectors/postgres-source.js";
import { JobRunner } from "../../src/core/runner.js";
import { describeDb, testDatabaseUrl } from "../helpers/db.js";

const { Pool } = pg;

describeDb("Postgres connectors (real database)", () => {
  let pool: pg.Pool;
  let schema: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl, max: 10 });
    schema = `test_conn_${randomBytes(6).toString("hex")}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await pool.end().catch(() => {});
    }
  });

  describe("PostgresSource", () => {
    it("performs keyset pagination and handles equal timestamps at batch boundaries", async () => {
      const srcTable = `${schema}.src_users`;
      await pool.query(`
        CREATE TABLE ${srcTable} (
          id text PRIMARY KEY,
          name text NOT NULL,
          updated_at timestamptz NOT NULL
        )
      `);

      // Insert 4 rows: 2 of them share the exact same updated_at timestamp!
      const ts1 = new Date(Date.now() - 20_000).toISOString();
      const ts2 = new Date(Date.now() - 10_000).toISOString();

      await pool.query(
        `INSERT INTO ${srcTable} (id, name, updated_at) VALUES
          ('u1', 'Alice', $1),
          ('u2', 'Bob', $1),
          ('u3', 'Charlie', $2),
          ('u4', 'Diana', $2)
        `,
        [ts1, ts2],
      );

      const source = new PostgresSource({
        connectionString: testDatabaseUrl,
        table: srcTable,
        cursorColumn: "updated_at",
        keyColumn: "id",
        safetyLagMs: 1000, // Only 1s safety lag so our test rows (10s and 20s old) are visible
      });

      const controller = new AbortController();
      await source.open(controller.signal);

      // Read batch 1 with limit 2: should read u1 and u2 (equal timestamp ts1, ordered by id)
      const batch1 = await source.readBatch(null, 2, controller.signal);
      expect(batch1.records).toHaveLength(2);
      expect(batch1.records.map((r) => r.key)).toEqual(["u1", "u2"]);
      expect(batch1.nextCursor).toBeDefined();

      // Read batch 2 from batch1.nextCursor: should read u3 and u4 without repeating u2
      const batch2 = await source.readBatch(batch1.nextCursor, 2, controller.signal);
      expect(batch2.records).toHaveLength(2);
      expect(batch2.records.map((r) => r.key)).toEqual(["u3", "u4"]);

      // Read batch 3: should be empty (caught up)
      const batch3 = await source.readBatch(batch2.nextCursor, 2, controller.signal);
      expect(batch3.records).toHaveLength(0);
      expect(batch3.nextCursor).toBeNull();

      await source.close();
    });

    it("withholds rows newer than safetyLagMs (late-commit hazard mitigation)", async () => {
      const lagTable = `${schema}.lag_test`;
      await pool.query(`
        CREATE TABLE ${lagTable} (
          id text PRIMARY KEY,
          val text NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      // Insert a row that is current (0ms old)
      await pool.query(`INSERT INTO ${lagTable} (id, val, updated_at) VALUES ('curr', 'fresh', now())`);

      // With safetyLagMs = 30_000, current rows must NOT be read yet
      const source = new PostgresSource({
        connectionString: testDatabaseUrl,
        table: lagTable,
        cursorColumn: "updated_at",
        keyColumn: "id",
        safetyLagMs: 30_000,
      });

      const controller = new AbortController();
      await source.open(controller.signal);

      const batch = await source.readBatch(null, 10, controller.signal);
      expect(batch.records).toHaveLength(0);

      await source.close();
    });
  });

  describe("PostgresDestination", () => {
    it("upserts rows with ON CONFLICT DO UPDATE WHERE IS DISTINCT FROM", async () => {
      const dstTable = `${schema}.dst_users`;
      await pool.query(`
        CREATE TABLE ${dstTable} (
          id text PRIMARY KEY,
          email text NOT NULL,
          name text NOT NULL
        )
      `);

      const dest = new PostgresDestination({
        connectionString: testDatabaseUrl,
        table: dstTable,
        keyColumn: "id",
      });

      const controller = new AbortController();
      await dest.open(controller.signal);

      // 1. Initial write: insert
      const res1 = await dest.write(
        { key: "u1", idempotencyKey: "k1", data: { id: "u1", email: "alice@test.com", name: "Alice" } },
        controller.signal,
      );
      expect(res1.status).toBe("written");

      // Verify row exists
      const check1 = await pool.query(`SELECT * FROM ${dstTable} WHERE id = 'u1'`);
      expect(check1.rows[0].name).toBe("Alice");

      // 2. Duplicate write with identical content: should report unchanged
      const res2 = await dest.write(
        { key: "u1", idempotencyKey: "k2", data: { id: "u1", email: "alice@test.com", name: "Alice" } },
        controller.signal,
      );
      expect(res2.status).toBe("unchanged");

      // 3. Update write with modified content: should report written
      const res3 = await dest.write(
        { key: "u1", idempotencyKey: "k3", data: { id: "u1", email: "alice@test.com", name: "Alice B." } },
        controller.signal,
      );
      expect(res3.status).toBe("written");

      const check2 = await pool.query(`SELECT * FROM ${dstTable} WHERE id = 'u1'`);
      expect(check2.rows[0].name).toBe("Alice B.");

      await dest.close();
    });

    it("plan() correctly predicts create, unchanged, and update actions", async () => {
      const planTable = `${schema}.plan_test`;
      await pool.query(`
        CREATE TABLE ${planTable} (
          id text PRIMARY KEY,
          score integer NOT NULL
        )
      `);

      const dest = new PostgresDestination({
        connectionString: testDatabaseUrl,
        table: planTable,
        keyColumn: "id",
      });

      const controller = new AbortController();
      await dest.open(controller.signal);

      // Plan for non-existent row -> create
      const planCreate = await dest.plan(
        { key: "p1", idempotencyKey: "k1", data: { id: "p1", score: 100 } },
        controller.signal,
      );
      expect(planCreate.action).toBe("create");

      // Actually write the row
      await dest.write(
        { key: "p1", idempotencyKey: "k1", data: { id: "p1", score: 100 } },
        controller.signal,
      );

      // Plan for identical row -> unchanged
      const planUnchanged = await dest.plan(
        { key: "p1", idempotencyKey: "k2", data: { id: "p1", score: 100 } },
        controller.signal,
      );
      expect(planUnchanged.action).toBe("unchanged");

      // Plan for modified row -> update
      const planUpdate = await dest.plan(
        { key: "p1", idempotencyKey: "k3", data: { id: "p1", score: 200 } },
        controller.signal,
      );
      expect(planUpdate.action).toBe("update");

      await dest.close();
    });
  });

  describe("End-to-End PG to PG sync via JobRunner", () => {
    it("synchronizes source table to destination table", async () => {
      const srcT = `${schema}.e2e_src`;
      const dstT = `${schema}.e2e_dst`;

      await pool.query(`
        CREATE TABLE ${srcT} (
          id text PRIMARY KEY,
          first_name text NOT NULL,
          last_name text NOT NULL,
          updated_at timestamptz NOT NULL
        );
        CREATE TABLE ${dstT} (
          id text PRIMARY KEY,
          full_name text NOT NULL
        );
      `);

      const oldTime = new Date(Date.now() - 30_000).toISOString();
      await pool.query(`
        INSERT INTO ${srcT} (id, first_name, last_name, updated_at) VALUES
          ('1', 'Grace', 'Hopper', '${oldTime}'),
          ('2', 'Alan', 'Turing', '${oldTime}');
      `);

      const src = new PostgresSource({
        connectionString: testDatabaseUrl,
        table: srcT,
        cursorColumn: "updated_at",
        keyColumn: "id",
        safetyLagMs: 1000,
      });

      const dst = new PostgresDestination({
        connectionString: testDatabaseUrl,
        table: dstT,
        keyColumn: "id",
      });

      // Simple in-memory mock store for JobRunner test or real store
      const { StateStore } = await import("../../src/db/store.js");
      const { ConnectorRegistry } = await import("../../src/core/registry.js");
      const store = new StateStore(pool, { schema });
      await store.migrate();

      await store.createJob({
        version: 1,
        name: "e2e_pg_sync",
        source: { type: "postgres", config: {} },
        destination: { type: "postgres", config: {} },
        transform: [
          { op: "concat", from: ["first_name", "last_name"], to: "full_name", separator: " " },
          { op: "drop", fields: ["first_name", "last_name", "updated_at"] },
        ],
        batchSize: 10,
        concurrency: 2,
        onRecordFailure: "halt",
        circuitBreaker: { maxConsecutiveFailures: 5 },
        retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitter: "none" },
      });

      const registry = new ConnectorRegistry();
      registry.registerSource("postgres", () => src);
      registry.registerDestination("postgres", () => dst);

      const runner = new JobRunner({ store, registry });
      const result = await runner.run("e2e_pg_sync", { trigger: "manual" });


      expect(result.state).toBe("succeeded");
      expect(result.counters.discovered).toBe(2);
      expect(result.counters.succeeded).toBe(2);

      // Verify destination table contents
      const dstRows = await pool.query(`SELECT * FROM ${dstT} ORDER BY id ASC`);
      expect(dstRows.rows).toHaveLength(2);
      expect(dstRows.rows[0].full_name).toBe("Grace Hopper");
      expect(dstRows.rows[1].full_name).toBe("Alan Turing");

      await src.close();
      await dst.close();
    });
  });
});
