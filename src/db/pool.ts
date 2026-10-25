import pg from "pg";
import type { Pool, PoolConfig } from "pg";
import type { Logger } from "../core/logger.js";

const { Pool: PgPool } = pg;

export interface CreatePoolOptions {
  config?: PoolConfig | string;
  logger?: Logger;
  schema?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

function decodeSafe(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

/**
 * Robustly parses a PostgreSQL connection string into a PoolConfig object.
 *
 * Handles passwords containing raw or encoded special characters (@, #, :, %, ?, /)
 * without requiring the user to manually URL-encode their password or change it.
 *
 * Structural invariant: The host delimiter '@' is the LAST '@' that appears
 * before the database path ('/...') or query parameters ('?...').
 */
export function parseConnectionString(rawUrl: string): PoolConfig {
  const str = rawUrl.trim();

  // Strip protocol
  const afterProto = str.replace(/^postgres(?:ql)?:\/\//, "");

  // Separate query string if present
  let mainPart = afterProto;
  let queryString = "";
  const qIdx = mainPart.indexOf("?");
  if (qIdx !== -1) {
    queryString = mainPart.slice(qIdx + 1);
    mainPart = mainPart.slice(0, qIdx);
  }

  // Separate database path if present
  let credsAndHost = mainPart;
  let database = "";
  const slashIdx = mainPart.indexOf("/");
  if (slashIdx !== -1) {
    database = mainPart.slice(slashIdx + 1);
    credsAndHost = mainPart.slice(0, slashIdx);
  }

  // Auto-heal: If user accidentally replaced the '@' delimiter before the host with '%40'
  // (e.g. user:pass%40386%40aws-0-... instead of user:pass%40386@aws-0-...)
  if (!credsAndHost.includes("@") && credsAndHost.includes("%40")) {
    const lastEncodedAt = credsAndHost.lastIndexOf("%40");
    const potentialHost = credsAndHost.slice(lastEncodedAt + 3);
    if (potentialHost.includes(".") || potentialHost.includes(":") || potentialHost === "localhost") {
      credsAndHost = credsAndHost.slice(0, lastEncodedAt) + "@" + potentialHost;
    }
  }

  // Find the LAST '@' in credsAndHost. Hostnames cannot contain '@',
  // so the last '@' is unambiguously the boundary between credentials and host.
  const atIdx = credsAndHost.lastIndexOf("@");
  let user: string | undefined;
  let password: string | undefined;
  let hostAndPort = credsAndHost;

  if (atIdx !== -1) {
    const credentials = credsAndHost.slice(0, atIdx);
    hostAndPort = credsAndHost.slice(atIdx + 1);

    const colonIdx = credentials.indexOf(":");
    if (colonIdx !== -1) {
      user = credentials.slice(0, colonIdx);
      password = credentials.slice(colonIdx + 1);
    } else {
      user = credentials;
    }
  }

  // Parse host and port
  let host = hostAndPort;
  let port: number | undefined;

  if (hostAndPort.startsWith("[")) {
    // IPv6 address
    const closeBracket = hostAndPort.indexOf("]");
    if (closeBracket !== -1) {
      host = hostAndPort.slice(1, closeBracket);
      const afterBracket = hostAndPort.slice(closeBracket + 1);
      if (afterBracket.startsWith(":")) {
        const p = Number(afterBracket.slice(1));
        if (!isNaN(p)) port = p;
      }
    }
  } else {
    const colonIdx = hostAndPort.lastIndexOf(":");
    if (colonIdx !== -1) {
      host = hostAndPort.slice(0, colonIdx);
      const p = Number(hostAndPort.slice(colonIdx + 1));
      if (!isNaN(p)) port = p;
    }
  }

  const isRemote = host !== "" && !host.includes("localhost") && !host.includes("127.0.0.1");

  // Query parameter overrides
  const searchParams = new URLSearchParams(queryString);
  const sslmode = searchParams.get("sslmode");
  let ssl: PoolConfig["ssl"];
  if (sslmode === "disable") {
    ssl = false;
  } else if (isRemote || sslmode === "require" || sslmode === "verify-ca" || sslmode === "verify-full") {
    ssl = { rejectUnauthorized: false };
  }

  const rawUser = user !== undefined ? decodeSafe(user) : undefined;
  const rawPassword = password !== undefined ? decodeSafe(password) : undefined;
  const rawDatabase = database ? decodeSafe(database) : undefined;

  const poolConfig: PoolConfig = {
    host: host || "localhost",
    port: port ?? 5432,
    database: rawDatabase,
    user: rawUser,
    password: rawPassword,
    ssl,
    // Pass search_path as a PostgreSQL startup parameter.
    // This is included in the connection handshake, so Supavisor
    // (transaction-mode pooler, port 6543) honours it properly —
    // unlike a post-connection SET which is dropped between transactions.
    options: "-c search_path=public",
  };

  return poolConfig;
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
  const { config, logger, max, idleTimeoutMillis, connectionTimeoutMillis } = options;

  let poolConfig: PoolConfig;
  if (typeof config === "string") {
    poolConfig = parseConnectionString(config);
  } else if (config) {
    poolConfig = { ...config };
  } else {
    poolConfig = {};
  }

  // Sensible production defaults if not overridden
  if (max !== undefined) {
    poolConfig.max = max;
  } else if (poolConfig.max === undefined) {
    poolConfig.max = 10;
  }

  if (idleTimeoutMillis !== undefined) {
    poolConfig.idleTimeoutMillis = idleTimeoutMillis;
  } else if (poolConfig.idleTimeoutMillis === undefined) {
    poolConfig.idleTimeoutMillis = 30_000;
  }

  if (connectionTimeoutMillis !== undefined) {
    poolConfig.connectionTimeoutMillis = connectionTimeoutMillis;
  } else if (poolConfig.connectionTimeoutMillis === undefined) {
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
