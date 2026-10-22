import { existsSync } from "node:fs";
import { createCliContext } from "../config.js";
import { ExitCodes, type ExitCode } from "../exit-codes.js";
import { validateJobFile } from "./validate.js";
import type { RunResult } from "../../core/runner.js";

export interface SyncCliOptions {
  dryRun?: boolean;
  limit?: string | number;
  db?: string;
  schema?: string;
  json?: boolean;
  logLevel?: "debug" | "info" | "warn" | "error" | "silent";
}

export async function runSync(jobOrFile: string, options: SyncCliOptions): Promise<ExitCode> {
  const isFile = jobOrFile.endsWith(".yaml") || jobOrFile.endsWith(".yml") || jobOrFile.endsWith(".json") || existsSync(jobOrFile);

  let jobName = jobOrFile;

  const rawLevel = (options.logLevel ?? process.env.LOG_LEVEL?.toLowerCase() ?? "info") as
    | "debug"
    | "info"
    | "warn"
    | "error"
    | "silent";
  const logLevel = ["debug", "info", "warn", "error", "silent"].includes(rawLevel) ? rawLevel : "info";

  const isSilent = logLevel === "silent";
  const isErrorOnly = logLevel === "error";
  const isWarnOnly = logLevel === "warn" || isErrorOnly;

  const logger = options.json || isSilent
    ? undefined
    : {
        debug(event: string, data?: Record<string, unknown>) {
          if (logLevel === "debug") {
            console.log(`  [Debug] ${event}`, data ?? "");
          }
        },
        info(event: string, data?: Record<string, unknown>) {
          if (!isWarnOnly && event === "batch.committed") {
            const batch = data?.batch;
            const records = data?.records;
            console.log(`  Committed batch ${batch} (${records} records)`);
          }
        },
        warn(event: string, data?: Record<string, unknown>) {
          if (!isErrorOnly && (event === "destination.retry" || event === "source.retry")) {
            console.warn(`  [Retry] ${event}: ${data?.error ?? ""}`);
          }
        },
        error(event: string, data?: Record<string, unknown>) {
          console.error(`  [Error] ${event}: ${data?.error ?? ""}`);
        },
      };

  const ctx = await createCliContext(
    {
      dbUrl: options.db,
      schema: options.schema,
    },
    logger,
  );

  if (!options.json && !isSilent && !isErrorOnly) {
    console.log(`[SyncSuite] Connected to database (schema: ${ctx.schema})`);
  }

  const abortController = new AbortController();
  const handleSignal = () => {
    if (!options.json) {
      console.error("\nReceived interrupt signal. Gracefully cancelling active sync...");
    }
    abortController.abort(new Error("Interrupted by signal"));
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    if (isFile) {
      const validation = validateJobFile(jobOrFile);
      if (!validation.valid || !validation.spec) {
        if (options.json) {
          console.error(JSON.stringify({ error: "Validation failed", issues: validation.errors }, null, 2));
        } else {
          console.error(`Error: Job file '${jobOrFile}' is invalid:`);
          for (const err of validation.errors) {
            console.error(`  - ${err}`);
          }
        }
        return ExitCodes.VALIDATION_ERROR;
      }

      if (!options.json && validation.warnings.length > 0) {
        for (const warn of validation.warnings) {
          console.warn(`Warning: ${warn}`);
        }
      }

      const upserted = await ctx.store.upsertJob(validation.spec);
      jobName = upserted.job.name;
      if (!options.json) {
        console.log(`Job '${jobName}' ${upserted.created ? "created" : "updated"} (spec version ${upserted.job.specVersion}).`);
      }
    }

    const maxRecords = options.limit ? Number(options.limit) : undefined;
    const dryRun = options.dryRun ?? false;

    if (!options.json) {
      console.log(`Starting sync for job '${jobName}'${dryRun ? " [DRY RUN]" : ""}...`);
    }

    const result: RunResult = await ctx.runner.run(jobName, {
      dryRun,
      maxRecords,
      signal: abortController.signal,
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("\nSync Execution Result:");
      console.log(`  Run ID:    ${result.runId}`);
      console.log(`  State:     ${result.state}`);
      console.log(`  Counters:`);
      console.log(`    Discovered:  ${result.counters.discovered}`);
      console.log(`    Processed:   ${result.counters.processed}`);
      console.log(`    Succeeded:   ${result.counters.succeeded}`);
      console.log(`    Unchanged:   ${result.counters.unchanged}`);
      console.log(`    Failed:      ${result.counters.failed}`);

      if (result.dryRun && result.dryRun.length > 0) {
        console.log(`\nDry Run Plan (${result.dryRun.length} records inspected):`);
        for (const entry of result.dryRun.slice(0, 20)) {
          const action = entry.outcome === "would_write" ? entry.plan?.action ?? "would_write" : entry.outcome;
          console.log(`  [${entry.key}] -> ${action}`);
        }
        if (result.dryRun.length > 20) {
          console.log(`  ... and ${result.dryRun.length - 20} more records.`);
        }
      }

      if (result.error) {
        console.error(`\nFailure Details:`);
        console.error(`  Kind:    ${result.error.kind}`);
        console.error(`  Message: ${result.error.message}`);
      }
    }

    switch (result.state) {
      case "succeeded":
        return ExitCodes.SUCCESS;
      case "partial":
        return ExitCodes.PARTIAL;
      case "cancelled":
        return ExitCodes.INTERRUPTED;
      case "failed":
      default:
        return ExitCodes.ERROR;
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      return ExitCodes.INTERRUPTED;
    }

    const msg = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.error(JSON.stringify({ error: msg }, null, 2));
    } else {
      console.error(`Sync error: ${msg}`);
    }

    if (msg.includes("job not found")) return ExitCodes.JOB_NOT_FOUND;
    if (msg.includes("already has an active run")) return ExitCodes.JOB_BUSY;
    return ExitCodes.ERROR;
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    await ctx.close().catch(() => {});
  }
}
