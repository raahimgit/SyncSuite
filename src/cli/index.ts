#!/usr/bin/env node

import { Command } from "commander";
import { ExitCodes } from "./exit-codes.js";
import { runInit } from "./commands/init.js";
import { runSetup } from "./commands/setup.js";
import { validateJobFile } from "./commands/validate.js";
import { runSync } from "./commands/sync.js";
import { runJobsList, runJobsShow, runJobsApply, runJobsDelete } from "./commands/jobs.js";
import { runStatus } from "./commands/status.js";
import { runRetry } from "./commands/retry.js";
import { runLogs } from "./commands/logs.js";
import { startApiServer } from "../api/server.js";

const program = new Command();

program
  .name("syncsuite")
  .description("Self-hostable incremental data synchronization engine CLI")
  .version("0.0.0");

// 1. setup
program
  .command("setup")
  .description("Scaffold SyncSuite into your project (job spec, .env.example, and package.json scripts)")
  .option("-t, --template <type>", "Starter template: postgres-to-postgres, postgres-to-rest, postgres-to-s3", "postgres-to-postgres")
  .option("--job-file <path>", "Name for the generated job spec file", "syncsuite.yaml")
  .option("--no-inject-scripts", "Skip injecting syncsuite:* scripts into package.json")
  .option("--force", "Overwrite files that already exist", false)
  .option("--quiet", "Suppress all output except errors", false)
  .action((options: { template: string; jobFile: string; injectScripts: boolean; force: boolean; quiet: boolean }) => {
    const code = runSetup({
      template: options.template as "postgres-to-postgres" | "postgres-to-rest" | "postgres-to-s3",
      jobFile: options.jobFile,
      injectScripts: options.injectScripts,
      force: options.force,
      quiet: options.quiet,
    });
    process.exit(code);
  });

// 2. init
program
  .command("init [path]")
  .description("Scaffold a single job spec template (see also: setup for full project scaffolding)")
  .option("-t, --template <type>", "Template type: postgres-to-rest or postgres-to-postgres", "postgres-to-rest")
  .option("-f, --format <format>", "Configuration format: yaml or json", "yaml")
  .option("--force", "Overwrite destination file if it already exists", false)
  .action((path: string | undefined, options: { template: string; format: string; force: boolean }) => {
    try {
      const generatedPath = runInit(path, {
        template: options.template as "postgres-to-rest" | "postgres-to-postgres" | "postgres-to-s3",
        format: options.format as "yaml" | "json",
        force: options.force,
      });
      console.log(`Initialized job specification template at: ${generatedPath}`);
      process.exit(ExitCodes.SUCCESS);
    } catch (err) {
      console.error(`Init failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(ExitCodes.ERROR);
    }
  });

// 2. validate
program
  .command("validate <file>")
  .description("Validate a job specification file against schema and security best practices")
  .option("--json", "Output validation report as JSON", false)
  .action((file: string, options: { json: boolean }) => {
    const report = validateJobFile(file);

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.valid ? ExitCodes.SUCCESS : ExitCodes.VALIDATION_ERROR);
    }

    if (report.valid) {
      console.log(`Job specification '${file}' is valid.`);
      if (report.warnings.length > 0) {
        console.log("\nWarnings:");
        for (const w of report.warnings) {
          console.warn(`  [!] ${w}`);
        }
      }
      process.exit(ExitCodes.SUCCESS);
    } else {
      console.error(`Validation failed for '${file}':`);
      for (const err of report.errors) {
        console.error(`  - ${err}`);
      }
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
  });

// 3. sync
program
  .command("sync <job-or-file>")
  .description("Run synchronization for a job name or from a job specification file")
  .option("--dry-run", "Simulate read and transformation without writing to destination", false)
  .option("--limit <n>", "Stop after processing at most n records")
  .option("--db <url>", "PostgreSQL state store connection URL")
  .option("--schema <name>", "PostgreSQL schema name", "synckit")
  .option("--json", "Output run result as JSON", false)
  .option("--log-level <level>", "Log verbosity: debug, info, warn, error, silent", "info")
  .action(async (jobOrFile: string, options: { dryRun?: boolean; limit?: string; db?: string; schema?: string; json?: boolean; logLevel?: "debug" | "info" | "warn" | "error" | "silent" }) => {
    const code = await runSync(jobOrFile, options);
    process.exit(code);
  });

// 4. jobs
const jobsCommand = program.command("jobs").description("Manage registered sync jobs");

jobsCommand
  .command("list")
  .description("List all registered jobs")
  .option("--db <url>", "PostgreSQL state store connection URL")
  .option("--schema <name>", "PostgreSQL schema name", "synckit")
  .option("--json", "Output as JSON", false)
  .action(async (options: { db?: string; schema?: string; json?: boolean }) => {
    const code = await runJobsList(options);
    process.exit(code);
  });

jobsCommand
  .command("show <name>")
  .description("Display details and specification of a registered job")
  .option("--db <url>", "PostgreSQL state store connection URL")
  .option("--schema <name>", "PostgreSQL schema name", "synckit")
  .option("--json", "Output as JSON", false)
  .action(async (name: string, options: { db?: string; schema?: string; json?: boolean }) => {
    const code = await runJobsShow(name, options);
    process.exit(code);
  });

jobsCommand
  .command("apply <file>")
  .description("Create or update a job from a specification file")
  .option("--db <url>", "PostgreSQL state store connection URL")
  .option("--schema <name>", "PostgreSQL schema name", "synckit")
  .option("--json", "Output as JSON", false)
  .action(async (file: string, options: { db?: string; schema?: string; json?: boolean }) => {
    const code = await runJobsApply(file, options);
    process.exit(code);
  });

jobsCommand
  .command("delete <name>")
  .description("Delete a registered job")
  .option("--db <url>", "PostgreSQL state store connection URL")
  .option("--schema <name>", "PostgreSQL schema name", "synckit")
  .option("--json", "Output as JSON", false)
  .action(async (name: string, options: { db?: string; schema?: string; json?: boolean }) => {
    const code = await runJobsDelete(name, options);
    process.exit(code);
  });

// 5. status
program
  .command("status [job]")
  .description("Inspect status and metrics for a specific job or all registered jobs")
  .option("--db <url>", "PostgreSQL state store connection URL")
  .option("--schema <name>", "PostgreSQL schema name", "synckit")
  .option("--json", "Output as JSON", false)
  .action(async (job: string | undefined, options: { db?: string; schema?: string; json?: boolean }) => {
    const code = await runStatus(job, options);
    process.exit(code);
  });

// 6. retry
program
  .command("retry <job>")
  .description("Re-drive open dead letters for a job")
  .option("--id <deadLetterId>", "Retry a specific dead letter by ID")
  .option("--limit <n>", "Limit the number of dead letters to retry")
  .option("--db <url>", "PostgreSQL state store connection URL")
  .option("--schema <name>", "PostgreSQL schema name", "synckit")
  .option("--json", "Output as JSON", false)
  .action(async (job: string, options: { id?: string; limit?: string; db?: string; schema?: string; json?: boolean }) => {
    const code = await runRetry(job, options);
    process.exit(code);
  });

// 7. logs
program
  .command("logs <run-id>")
  .description("Display execution event logs for a given run ID")
  .option("--limit <n>", "Max log records to fetch", "100")
  .option("--level <level>", "Filter by level (debug, info, warn, error)")
  .option("--db <url>", "PostgreSQL state store connection URL")
  .option("--schema <name>", "PostgreSQL schema name", "synckit")
  .option("--json", "Output as JSON", false)
  .action(async (runId: string, options: { limit?: string; level?: string; db?: string; schema?: string; json?: boolean }) => {
    const code = await runLogs(runId, options);
    process.exit(code);
  });

// 8. serve (API daemon)
program
  .command("serve")
  .description("Start the SyncSuite HTTP API service daemon")
  .option("-p, --port <number>", "HTTP port to bind", "3000")
  .option("-h, --host <host>", "Host address to bind", "127.0.0.1")
  .option("--db <url>", "PostgreSQL state store connection URL")
  .option("--schema <name>", "PostgreSQL schema name", "synckit")
  .option("--token <token>", "Bearer authentication token for securing API")
  .action(async (options: { port: string; host: string; db?: string; schema?: string; token?: string }) => {
    try {
      const server = await startApiServer({
        port: Number(options.port),
        host: options.host,
        dbUrl: options.db,
        schema: options.schema,
        bearerToken: options.token ?? process.env.SYNCSUITE_API_TOKEN ?? process.env.SYNCKIT_API_TOKEN,
      });

      console.log(`SyncSuite HTTP API daemon running at http://${options.host}:${options.port}`);
      if (options.token || process.env.SYNCSUITE_API_TOKEN || process.env.SYNCKIT_API_TOKEN) {
        console.log("Authentication: Bearer token enforced.");
      } else {
        console.log("Authentication: Warning - Running without bearer token.");
      }

      const shutdown = async () => {
        console.log("\nShutting down API daemon...");
        await server.close();
        process.exit(ExitCodes.SUCCESS);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (err) {
      console.error(`Failed to start API server: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(ExitCodes.ERROR);
    }
  });

program.parse(process.argv);
