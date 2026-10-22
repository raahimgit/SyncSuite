import pg from "pg";
import type { Pool, PoolConfig } from "pg";
import type { Logger } from "../core/logger.js";

const { Pool: PgPool } = pg;

export interface CreatePoolOptions {
  config?: PoolConfig | string;
  logger?: Logger;
  schema?: string;
}

/**
 * Creates a PostgreSQL connection pool configured for SyncSuite.
 *
 * Attaches an error handler to catch errors emitted by idle clients in the pool
 * (e.g., backend restarts, socket timeouts, network drops). Without an error
 * listener on the Pool instance, Node.js treats idle client errors as unhandled
 * exceptions and terminates the process.
 */
export function createPool(options: CreatePoolOptions = {}): Pool {
  const { config, logger } = options;

  let poolConfig: PoolConfig;
  if (typeof config === "string") {
    poolConfig = { connectionString: config };
  } else {
    poolConfig = { ...config };
  }

  // Sensible production defaults if not overridden
  if (poolConfig.max === undefined) {
    poolConfig.max = 10;
  }
  if (poolConfig.idleTimeoutMillis === undefined) {
    poolConfig.idleTimeoutMillis = 30_000;
  }
  if (poolConfig.connectionTimeoutMillis === undefined) {
    poolConfig.connectionTimeoutMillis = 10_000;
  }

  const pool = new PgPool(poolConfig);



  pool.on("error", (err: Error) => {
    logger?.error("pg.pool_idle_client_error", {
      error: err.message,
      stack: err.stack,
    });
  });

  return pool;
}
