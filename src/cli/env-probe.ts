/**
 * env-probe.ts
 *
 * Probes the current project's files to locate a DATABASE_URL (or equivalent)
 * without ever storing or persisting any discovered credential.
 *
 * Detection order (first match wins):
 *   1. Already in process.env (set by the OS, CI, or container platform)
 *   2. .env / .env.local / .env.development / .env.production  (standard dotenv files)
 *   3. TypeScript/JS config files that export or assign DATABASE_URL
 *      (e.g. src/env.ts, src/config.ts, src/lib/db.ts, config/database.ts, etc.)
 *
 * Security constraints:
 *   - Credentials are NEVER written to disk by this module.
 *   - Discovered values are only injected into the running process.env for the
 *     duration of the current CLI invocation. They disappear when the process exits.
 *   - We only read, never write.
 *
 * This is read-only, in-memory, and scoped to the invocation.
 */

import fs from "node:fs";
import path from "node:path";

// ─── Env file probe ───────────────────────────────────────────────────────────

const ENV_FILE_CANDIDATES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
];

/**
 * Minimal dotenv parser — handles KEY=VALUE and KEY="VALUE" lines.
 * Does NOT support multiline values, but is sufficient for connection strings.
 */
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Loads the first found .env* file and injects its variables into process.env.
 * Existing process.env values are NOT overwritten (platform env takes priority).
 * Returns the path of the file that was loaded, or null if none found.
 */
export function loadDotenvFiles(cwd: string): string | null {
  for (const filename of ENV_FILE_CANDIDATES) {
    const filepath = path.resolve(cwd, filename);
    if (!fs.existsSync(filepath)) continue;
    try {
      const content = fs.readFileSync(filepath, "utf8");
      const parsed = parseEnvFile(content);
      let loaded = false;
      for (const [key, value] of Object.entries(parsed)) {
        if (!process.env[key]) {
          process.env[key] = value;
          loaded = true;
        }
      }
      if (loaded) return filepath;
    } catch {
      // Unreadable — skip
    }
  }
  return null;
}

// ─── Source file probe ────────────────────────────────────────────────────────

/**
 * Common TypeScript/JS source file paths that projects often store DB config in.
 * We scan these with a simple regex — we do NOT execute any code.
 */
const SOURCE_FILE_CANDIDATES = [
  "src/env.ts",
  "src/env.js",
  "src/config.ts",
  "src/config.js",
  "src/db.ts",
  "src/db.js",
  "src/database.ts",
  "src/database.js",
  "src/lib/db.ts",
  "src/lib/db.js",
  "src/lib/env.ts",
  "src/lib/env.js",
  "src/lib/config.ts",
  "src/lib/config.js",
  "src/utils/env.ts",
  "src/utils/env.js",
  "config/database.ts",
  "config/database.js",
  "config/db.ts",
  "config/db.js",
  "lib/db.ts",
  "lib/db.js",
  "lib/env.ts",
  "lib/env.js",
];

/**
 * Patterns that indicate a DATABASE_URL assignment or export in source code.
 * We extract the literal string value if present (single or double quoted).
 * We deliberately ignore template literals and variable references — those
 * can't be evaluated safely without executing the file.
 */
const DB_URL_PATTERNS = [
  // DATABASE_URL = "..."  or DATABASE_URL: "..."
  /DATABASE_URL\s*[:=]\s*["']([^"']+)["']/,
  // process.env.DATABASE_URL ?? "..."  fallback literal
  /process\.env\.DATABASE_URL\s*\?\?\s*["']([^"']+)["']/,
  // connectionString: "..."  (common pg pattern)
  /connectionString\s*[:=]\s*["'](postgres(?:ql)?:\/\/[^"']+)["']/,
];

/**
 * Scans known source file locations for a literal DATABASE_URL string.
 * Returns the first discovered URL and the source file it was found in,
 * or null if nothing is found.
 *
 * NEVER executes any code — pure regex text scan only.
 */
export function probeSourceFiles(cwd: string): { url: string; source: string } | null {
  for (const relPath of SOURCE_FILE_CANDIDATES) {
    const filepath = path.resolve(cwd, relPath);
    if (!fs.existsSync(filepath)) continue;
    let content: string;
    try {
      content = fs.readFileSync(filepath, "utf8");
    } catch {
      continue;
    }
    for (const pattern of DB_URL_PATTERNS) {
      const match = pattern.exec(content);
      if (match?.[1]) {
        const url = match[1];
        // Basic sanity check: must look like a postgres connection string
        if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
          return { url, source: relPath };
        }
      }
    }
  }
  return null;
}

// ─── DB URL variable names SyncSuite understands ─────────────────────────────

const DB_ENV_CANDIDATES = [
  "DATABASE_URL",
  "SYNCSUITE_DATABASE_URL",
  "SYNCKIT_DATABASE_URL",
  "SYNCKIT_TEST_DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRESQL_URL",
  "PG_URL",
  "DB_URL",
];

/**
 * Returns the first set database URL env variable from process.env.
 */
export function findDatabaseUrlInEnv(): { varName: string; url: string } | null {
  for (const name of DB_ENV_CANDIDATES) {
    const val = process.env[name];
    if (val && (val.startsWith("postgres://") || val.startsWith("postgresql://"))) {
      return { varName: name, url: val };
    }
  }
  return null;
}

// ─── Primary export ───────────────────────────────────────────────────────────

export interface ProbeResult {
  /** The resolved DATABASE_URL for this invocation */
  url: string;
  /** Human-readable origin description (for log output only — never the URL itself) */
  source: string;
  /** The env variable name used (if resolved from env) */
  varName?: string;
}

/**
 * Full database URL resolution with smart auto-detection.
 *
 * Resolution order:
 *   1. Explicit --db flag value
 *   2. Already in process.env (SYNCSUITE_DATABASE_URL, DATABASE_URL, etc.)
 *   3. .env / .env.local / … dotenv files in cwd
 *   4. Literal string in known source files (src/env.ts, src/config.ts, etc.)
 *
 * Returns null if no URL could be located (caller should show a helpful error).
 * The discovered URL is injected into process.env[DATABASE_URL] in-memory only
 * so all downstream code can pick it up without changes.
 */
export function probeAndResolveDatabaseUrl(
  explicit: string | undefined,
  cwd: string = process.cwd(),
): ProbeResult | null {
  // 1. Explicit flag — highest priority
  if (explicit) {
    return { url: explicit, source: "--db flag" };
  }

  // 2. Already in process.env
  const fromEnv = findDatabaseUrlInEnv();
  if (fromEnv) {
    return { url: fromEnv.url, source: "environment", varName: fromEnv.varName };
  }

  // 3. Dotenv files — load and re-check
  const dotenvFile = loadDotenvFiles(cwd);
  if (dotenvFile) {
    const fromEnvAfterLoad = findDatabaseUrlInEnv();
    if (fromEnvAfterLoad) {
      const rel = path.relative(cwd, dotenvFile);
      return { url: fromEnvAfterLoad.url, source: rel, varName: fromEnvAfterLoad.varName };
    }
  }

  // 4. Source file literal scan
  const fromSource = probeSourceFiles(cwd);
  if (fromSource) {
    // Inject into process.env so downstream code picks it up
    process.env["DATABASE_URL"] = fromSource.url;
    return { url: fromSource.url, source: fromSource.source, varName: "DATABASE_URL" };
  }

  return null;
}

/**
 * Produces a masked version of a connection string safe for logging.
 * postgresql://user:PASSWORD@host:5432/db → postgresql://****@host:5432/db
 */
export function maskDatabaseUrl(url: string): string {
  if (url.includes("@")) {
    return url.replace(/:\/\/[^@]+@/, "://****@");
  }
  return url.replace(/:\/\/[^/?#]+/, "://****");
}
