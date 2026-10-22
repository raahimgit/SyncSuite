import { createPool } from "../db/pool.js";
import { StateStore } from "../db/store.js";
import type { ConnectorRegistry } from "../core/registry.js";
import { createDefaultRegistry } from "../connectors/index.js";
import { JobRunner } from "../core/runner.js";
import type { Logger } from "../core/logger.js";
import type { Pool } from "pg";

export interface CliContextOptions {
  dbUrl?: string;
  schema?: string;
  autoMigrate?: boolean;
}

export interface CliContext {
  pool: Pool;
  store: StateStore;
  registry: ConnectorRegistry;
  runner: JobRunner;
  schema: string;
  close: () => Promise<void>;
}

export function resolveDatabaseUrl(explicitUrl?: string): string {
  const url =
    explicitUrl ??
    process.env.SYNCSUITE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    process.env.SYNCKIT_TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "Database URL must be provided via --db, SYNCSUITE_DATABASE_URL, or DATABASE_URL environment variable.",
    );
  }
  return url;
}

export function resolveSchema(explicitSchema?: string): string {
  return explicitSchema ?? process.env.SYNCSUITE_SCHEMA ?? "synckit";
}

export async function createCliContext(options: CliContextOptions = {}, logger?: Logger): Promise<CliContext> {
  const dbUrl = resolveDatabaseUrl(options.dbUrl);
  const schema = resolveSchema(options.schema);

  const pool = createPool({
    config: dbUrl,
    schema,
    logger,
  });

  const store = new StateStore(pool, { schema });

  if (options.autoMigrate !== false) {
    await store.migrate();
  }

  const registry = createDefaultRegistry();
  const runner = new JobRunner({
    store,
    registry,
    logger,
  });

  return {
    pool,
    store,
    registry,
    runner,
    schema,
    close: async () => {
      await pool.end();
    },
  };
}
