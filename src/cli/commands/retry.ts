import { createCliContext } from "../config.js";
import { ExitCodes, type ExitCode } from "../exit-codes.js";
import type { RunResult } from "../../core/runner.js";

export interface RetryCliOptions {
  id?: string;
  limit?: string | number;
  db?: string;
  schema?: string;
  json?: boolean;
}

export async function runRetry(jobName: string, options: RetryCliOptions): Promise<ExitCode> {
  const ctx = await createCliContext({ dbUrl: options.db, schema: options.schema });
  try {
    const ids = options.id ? [options.id] : undefined;
    const limit = options.limit ? Number(options.limit) : undefined;

    if (!options.json) {
      console.log(`Re-driving dead letters for job '${jobName}'...`);
    }

    const res: RunResult = await ctx.runner.retry(jobName, { ids, limit });
    const processed = res.counters.processed;
    const succeeded = res.counters.succeeded;
    const failed = res.counters.failed;

    if (options.json) {
      console.log(JSON.stringify({ runId: res.runId, state: res.state, processed, succeeded, failed }, null, 2));
    } else {
      console.log(`Dead Letter Re-drive Complete:`);
      console.log(`  State:     ${res.state}`);
      console.log(`  Processed: ${processed}`);
      console.log(`  Resolved:  ${succeeded}`);
      console.log(`  Failed:    ${failed}`);
    }

    return failed > 0 ? ExitCodes.PARTIAL : ExitCodes.SUCCESS;
  } catch (err) {
    console.error(`Retry error: ${err instanceof Error ? err.message : String(err)}`);
    return ExitCodes.ERROR;
  } finally {
    await ctx.close().catch(() => {});
  }
}

