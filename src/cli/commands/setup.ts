/**
 * syncsuite setup
 *
 * One-command project scaffolding. Detects what already exists in the
 * target project and only creates what is missing:
 *
 *  1. syncsuite.yaml  – starter job spec (template chosen via --template flag)
 *  2. .env.example    – documents the required environment variables
 *                       (skipped if DATABASE_URL is already in the environment,
 *                        since platforms like Vercel/Railway manage envs natively)
 *  3. package.json    – injects convenience "syncsuite:*" scripts (opt-in)
 *
 * The command is intentionally non-destructive: it never overwrites files
 * that already exist unless --force is passed.
 *
 * DATABASE_URL is NEVER written to disk. It is read from the environment
 * at runtime so it works seamlessly on any platform (local, Vercel, Railway,
 * Render, Supabase, etc.).
 */

import fs from "node:fs";
import path from "node:path";
import { runInit } from "./init.js";
import { ExitCodes } from "../exit-codes.js";

export interface SetupOptions {
  /** Job template to scaffold (default: postgres-to-postgres) */
  template: "postgres-to-postgres" | "postgres-to-rest" | "postgres-to-s3";
  /** Where to write the job spec (default: syncsuite.yaml in cwd) */
  jobFile: string;
  /** Inject helper scripts into package.json (default: true) */
  injectScripts: boolean;
  /** Overwrite files that already exist (default: false) */
  force: boolean;
  /** Suppress all non-error output (default: false) */
  quiet: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string, quiet: boolean) {
  if (!quiet) console.log(msg);
}

function warn(msg: string) {
  console.warn(`  [!] ${msg}`);
}

function ok(msg: string, quiet: boolean) {
  if (!quiet) console.log(`  ✔  ${msg}`);
}

function skip(msg: string, quiet: boolean) {
  if (!quiet) console.log(`  –  ${msg} (skipping)`);
}

// ─── Step 0: detect DATABASE_URL ─────────────────────────────────────────────

/**
 * Returns the detected DATABASE_URL variable name from the current environment.
 * SyncSuite reads DATABASE_URL, SYNCSUITE_DATABASE_URL, or SYNCKIT_DATABASE_URL.
 * Returns null if none are set.
 */
function detectDatabaseUrl(): { varName: string; masked: string } | null {
  const candidates = ["DATABASE_URL", "SYNCSUITE_DATABASE_URL", "SYNCKIT_DATABASE_URL"];
  for (const name of candidates) {
    const val = process.env[name];
    if (val) {
      // Mask credentials: postgresql://user:PASS@host:port/db → postgresql://****@host:port/db
      const masked = val.replace(/:\/\/[^@]+@/, "://****@");
      return { varName: name, masked };
    }
  }
  return null;
}

// ─── Step 1: job spec ────────────────────────────────────────────────────────

function scaffoldJobSpec(opts: SetupOptions, cwd: string): boolean {
  const dest = path.resolve(cwd, opts.jobFile);

  if (fs.existsSync(dest) && !opts.force) {
    skip(`${opts.jobFile} already exists`, opts.quiet);
    return false;
  }

  try {
    runInit(dest, { template: opts.template, format: "yaml", force: opts.force });
    ok(`Created ${opts.jobFile}`, opts.quiet);
    return true;
  } catch (err) {
    warn(`Could not create ${opts.jobFile}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ─── Step 2: .env.example ────────────────────────────────────────────────────

const ENV_MARKER = "# ── SyncSuite ──";

/**
 * .env.example is a git-committed reference file that tells other developers
 * which environment variables they need to set. It contains placeholder values
 * only — never real credentials.
 *
 * Real credentials are set:
 *   - Locally:     in a .env file (which must be listed in .gitignore)
 *   - On Vercel:   Project Settings → Environment Variables
 *   - On Railway:  Service → Variables
 *   - On Render:   Service → Environment
 *   - On Supabase: Edge Functions → Secrets (for edge use)
 *   - On any platform: just set DATABASE_URL in the dashboard
 */
const ENV_BLOCK = `${ENV_MARKER}
# SyncSuite reads DATABASE_URL at runtime — set this in your platform's
# environment dashboard (Vercel, Railway, Render, etc.) or in a local .env file.
#
# It can point to any PostgreSQL-compatible database (including Supabase).
# SyncSuite will create its own tables in a separate schema — it does NOT
# modify your existing tables.
DATABASE_URL=postgresql://user:password@host:5432/dbname

# Optional: override the schema SyncSuite uses (default: synckit)
# SYNCSUITE_SCHEMA=synckit

# Optional: log verbosity toggle (debug, info, warn, error, silent). Default: info
# In production, set to 'warn' or 'error' to suppress routine batch logs and only
# output critical alerts (e.g. database drop, circuit breaker tripped, fatal stops).
# LOG_LEVEL=info

# Optional: bearer token to protect the SyncSuite HTTP API (syncsuite serve)
# SYNCSUITE_API_TOKEN=your-secret-token
`;

function scaffoldEnvExample(
  opts: SetupOptions,
  cwd: string,
  dbDetected: boolean,
): boolean {
  const dest = path.resolve(cwd, ".env.example");

  // If DATABASE_URL is already set in the environment (e.g. Vercel, Railway,
  // or a local .env), the developer's platform handles env management.
  // We still create .env.example as a reference for new contributors, but
  // we make clear it is documentation only, not a config file.
  if (dbDetected && !opts.force) {
    if (fs.existsSync(dest)) {
      const existing = fs.readFileSync(dest, "utf8");
      if (existing.includes(ENV_MARKER)) {
        skip(".env.example (DATABASE_URL already set in environment, reference file present)", opts.quiet);
        return false;
      }
    }
  }

  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, "utf8");
    if (existing.includes(ENV_MARKER)) {
      skip(".env.example (SyncSuite block already present)", opts.quiet);
      return false;
    }
    // Append to existing file without overwriting anything
    fs.writeFileSync(dest, `${existing.trimEnd()}\n\n${ENV_BLOCK}`);
    ok("Appended SyncSuite variables to .env.example (reference only — real values go in your platform env settings)", opts.quiet);
    return true;
  }

  fs.writeFileSync(dest, ENV_BLOCK);
  ok("Created .env.example (reference only — real values go in your platform env settings)", opts.quiet);
  return true;
}

// ─── Step 3: package.json scripts ────────────────────────────────────────────

const INJECTED_SCRIPTS: Record<string, string> = {
  "syncsuite:validate": `syncsuite validate syncsuite.yaml`,
  "syncsuite:apply": `syncsuite jobs apply syncsuite.yaml`,
  "syncsuite:dry-run": `syncsuite sync syncsuite.yaml --dry-run`,
  "syncsuite:sync": `syncsuite sync syncsuite.yaml`,
  "syncsuite:status": `syncsuite status`,
};

function injectPackageScripts(opts: SetupOptions, cwd: string): boolean {
  const pkgPath = path.resolve(cwd, "package.json");

  if (!fs.existsSync(pkgPath)) {
    warn("No package.json found — skipping script injection.");
    return false;
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  } catch {
    warn("Could not parse package.json — skipping script injection.");
    return false;
  }

  const scripts = (pkg["scripts"] ?? {}) as Record<string, string>;
  let added = 0;

  for (const [name, cmd] of Object.entries(INJECTED_SCRIPTS)) {
    if (!scripts[name]) {
      scripts[name] = cmd;
      added++;
    }
  }

  if (added === 0) {
    skip("package.json syncsuite:* scripts (all already present)", opts.quiet);
    return false;
  }

  pkg["scripts"] = scripts;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  ok(`Injected ${added} syncsuite:* scripts into package.json`, opts.quiet);
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function runSetup(opts: SetupOptions, cwd = process.cwd()): number {
  log("", opts.quiet);
  log("SyncSuite Setup", opts.quiet);
  log("═══════════════", opts.quiet);
  log("", opts.quiet);

  // Detect DATABASE_URL before doing anything
  const detected = detectDatabaseUrl();
  if (detected) {
    ok(`DATABASE_URL detected (${detected.varName}=${detected.masked})`, opts.quiet);
  } else {
    warn("DATABASE_URL is not set in the current environment.");
    log("", opts.quiet);
    log("  Set it in your platform's environment settings:", opts.quiet);
    log("    Vercel  → Project Settings → Environment Variables", opts.quiet);
    log("    Railway → Service → Variables", opts.quiet);
    log("    Render  → Service → Environment", opts.quiet);
    log("    Local   → create a .env file with: DATABASE_URL=postgresql://...", opts.quiet);
    log("", opts.quiet);
    log("  SyncSuite reads DATABASE_URL at runtime — you never paste it here.", opts.quiet);
    log("", opts.quiet);
  }

  scaffoldJobSpec(opts, cwd);
  scaffoldEnvExample(opts, cwd, detected !== null);

  if (opts.injectScripts) {
    injectPackageScripts(opts, cwd);
  }

  log("", opts.quiet);
  log("Done! Next steps:", opts.quiet);
  log("", opts.quiet);

  if (!detected) {
    log("  0. Set DATABASE_URL in your environment (see above)", opts.quiet);
  }

  log(`  ${detected ? "1" : "2"}. Edit ${opts.jobFile} to match your source and destination`, opts.quiet);
  log(`  ${detected ? "2" : "3"}. npm run syncsuite:apply   → register the job with your database`, opts.quiet);
  log(`  ${detected ? "3" : "4"}. npm run syncsuite:dry-run → preview what will be synced`, opts.quiet);
  log(`  ${detected ? "4" : "5"}. npm run syncsuite:sync    → run the sync`, opts.quiet);
  log("", opts.quiet);
  log("  Docs: https://github.com/raahimgit/syncsuite", opts.quiet);
  log("", opts.quiet);

  return ExitCodes.SUCCESS;
}
