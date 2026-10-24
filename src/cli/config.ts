import { createPool, parseConnectionString } from "../db/pool.js";
import { StateStore } from "../db/store.js";
import type { ConnectorRegistry } from "../core/registry.js";
import { createDefaultRegistry } from "../connectors/index.js";
import { JobRunner } from "../core/runner.js";
import type { Logger } from "../core/logger.js";
import type { Pool } from "pg";
import { probeAndResolveDatabaseUrl, maskDatabaseUrl } from "./env-probe.js";

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
  const probed = probeAndResolveDatabaseUrl(explicitUrl);

  if (!probed) {
    throw new Error(
      "No database URL found.\n\n" +
      "SyncSuite looked in:\n" +
      "  • SYNCSUITE_DATABASE_URL / DATABASE_URL environment variables\n" +
      "  • .env, .env.local, .env.production files in the project root\n" +
      "  • src/env.ts, src/config.ts, src/db.ts and other common config files\n\n" +
      "Set DATABASE_URL in your environment:\n" +
      "  Local dev  → add to .env:            DATABASE_URL=postgresql://...\n" +
      "  CI/CD      → set as a secret/var:    DATABASE_URL=postgresql://...\n" +
      "  Container  → set in env settings:    DATABASE_URL=postgresql://...\n\n" +
      "Tip: pass --db <url> to provide it directly for this command only."
    );
  }

  // Log detection source (masked) so developers can see where the URL came from.
  // Only print if the URL was auto-discovered (not passed explicitly via --db).
  if (probed.source !== "--db flag" && probed.source !== "environment") {
    const masked = maskDatabaseUrl(probed.url);
    process.stderr.write(
      `[syncsuite] Auto-detected database URL from ${probed.source} → ${masked}\n`
    );
  }

  return probed.url;
}

export function formatDatabaseError(err: unknown, dbUrl: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code;

  let host = "";
  let port = "";
  let username = "";
  let database = "";

  try {
    const parsed = parseConnectionString(dbUrl);
    host = parsed.host || "";
    port = parsed.port ? String(parsed.port) : "";
    username = parsed.user || "";
    database = parsed.database || "";
  } catch {
    const match = /@([^:/]+)(?::(\d+))?\/([^?]*)/.exec(dbUrl);
    if (match) {
      host = match[1] ?? "";
      port = match[2] || "";
      database = match[3] || "";
    }
  }

  const isSupabasePooler = host.includes("pooler.supabase.com");
  const isSupabaseDirect = host.includes(".supabase.co");
  const isSupabase = isSupabasePooler || isSupabaseDirect;

  const lines: string[] = [];
  lines.push(`Database connection failed: ${message}${code ? ` [${code}]` : ""}`);

  if (code === "28P01") {
    lines.push("");
    lines.push("Authentication Diagnostic:");
    if (isSupabasePooler && (!username.includes(".") || username === "postgres")) {
      lines.push(`  • Supabase Connection Pooler detected (${host}${port ? `:${port}` : ""})`);
      lines.push(`    Current username in URL: "${username}"`);
      lines.push("");
      lines.push("    CAUSE: Supabase connection poolers (*.pooler.supabase.com) require your project ref");
      lines.push("    in the username: postgres.[project-ref]");
      lines.push("    Using just 'postgres' without the project ref is rejected by Supavisor.");
      lines.push("");
      lines.push("    FIX: Update your DATABASE_URL in .env to use the pooler URI format:");
      lines.push(`      postgresql://postgres.[YOUR-PROJECT-REF]:[YOUR-PASSWORD]@${host}${port ? `:${port}` : ""}/${database || "postgres"}`);
      lines.push("");
      lines.push("    (Find your project ref in Supabase Dashboard → Project Settings → General)");
    } else {
      lines.push(`  • The database rejected the password for user '${username || "postgres"}'.`);
      lines.push("  • Verify the database password in your .env or connection string.");
      lines.push("  • Notice: Only special characters INSIDE the password should be URL-encoded (e.g. '@' → '%40', '#' → '%23').");
      lines.push("    The '@' symbol immediately before the hostname MUST remain a literal '@'.");
      if (isSupabase) {
        lines.push("");
        lines.push("  • Supabase Tip: If you don't recall the database password you set during project creation,");
        lines.push("    reset it in Supabase Dashboard → Project Settings → Database → 'Reset database password'.");
        lines.push("    (Note: This is your PostgreSQL database password, not your Supabase dashboard login password).");
      }
    }
  } else if (code === "ERR_INVALID_URL" || message.includes("Invalid URL")) {
    lines.push("");
    lines.push("URL Format Diagnostic:");
    if (!dbUrl.includes("@") && dbUrl.includes("%40")) {
      lines.push("  • The literal '@' separator between your credentials and the hostname is missing.");
      lines.push("  • It looks like the '@' separating the password and host was accidentally encoded as '%40'.");
      lines.push("  • Only encode special characters inside the password itself, keeping the delimiter '@' literal:");
      lines.push("      Correct: postgresql://user:pass%40123@aws-0-....pooler.supabase.com:6543/postgres");
      lines.push("      Wrong:   postgresql://user:pass%40123%40aws-0-....pooler.supabase.com:6543/postgres");
    } else {
      lines.push("  • The database connection string could not be parsed as a valid URL.");
      lines.push("  • Expected format: postgresql://[user]:[password]@[host]:[port]/[database]");
    }
  } else if (code === "ENOTFOUND") {
    lines.push("");
    lines.push("Network Diagnostic:");
    lines.push(`  • Could not resolve hostname '${host}'. Check for typos in your database URL.`);
  } else if (code === "ECONNREFUSED") {
    lines.push("");
    lines.push("Network Diagnostic:");
    lines.push(`  • Connection refused at ${host}:${port || "5432"}.`);
    lines.push("  • Verify that PostgreSQL is running and accepting connections on this host and port.");
  } else if (code === "ETIMEDOUT") {
    lines.push("");
    lines.push("Network Diagnostic:");
    lines.push(`  • Connection to ${host}:${port || "5432"} timed out.`);
    lines.push("  • Check firewall rules, security groups, or whether IPv6 / IPv4 settings apply.");
  }

  return lines.join("\n");
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
    try {
      await store.migrate();
    } catch (err: unknown) {
      await pool.end().catch(() => {});
      const formatted = formatDatabaseError(err, dbUrl);
      const error = new Error(formatted);
      Object.assign(error, {
        code: (err as { code?: string })?.code,
        originalError: err,
      });
      throw error;
    }
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
