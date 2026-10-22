import { randomBytes } from "node:crypto";
import pg from "pg";
import type { Pool } from "pg";
import { describe } from "vitest";
import { StateStore } from "../../src/db/store.js";

export const testDatabaseUrl =
  process.env["SYNCKIT_TEST_DATABASE_URL"] ||
  process.env["SYNCSUITE_DATABASE_URL"] ||
  process.env["DATABASE_URL"];

// Locally, database tests are skipped when no database is configured. In CI a
// missing database is a configuration error, not a reason to report green.
if (!testDatabaseUrl && process.env["CI"]) {
  throw new Error("SYNCKIT_TEST_DATABASE_URL must be set in CI; refusing to skip database tests");
}

export const describeDb = testDatabaseUrl ? describe : describe.skip;

export interface TestStore {
  pool: Pool;
  store: StateStore;
  schema: string;
  close(): Promise<void>;
}

// Each test file gets its own schema so files can run in parallel against one
// database without interfering.
export async function createTestStore(): Promise<TestStore> {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 8 });
  const schema = `synckit_t_${randomBytes(6).toString("hex")}`;
  const store = new StateStore(pool, { schema });
  await store.migrate();
  return {
    pool,
    store,
    schema,
    async close() {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    },
  };
}
