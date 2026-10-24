import { createCliContext, type CliContext } from "../config.js";
import { ExitCodes, type ExitCode } from "../exit-codes.js";

export interface LogsCliOptions {
  limit?: string | number;
  level?: string;
  db?: string;
  schema?: string;
  json?: boolean;
}

export async function runLogs(runId: string, options: LogsCliOptions): Promise<ExitCode> {
  let ctx: CliContext | undefined;
  try {
    ctx = await createCliContext({ dbUrl: options.db, schema: options.schema });
    const limit = options.limit ? Number(options.limit) : 100;
    const events = await ctx.store.listEvents(runId, limit);

    const filtered = options.level ? events.filter((e) => e.level === options.level) : events;

    if (options.json) {
      console.log(JSON.stringify(filtered, null, 2));
      return ExitCodes.SUCCESS;
    }

    if (filtered.length === 0) {
      console.log(`No logs recorded for run '${runId}'.`);
      return ExitCodes.SUCCESS;
    }

    console.log(`Event Logs for Run ${runId} (${filtered.length} entries):\n`);
    for (const ev of filtered) {
      const time = ev.ts.toISOString().split("T")[1]?.replace("Z", "") ?? ev.ts.toISOString();
      const levelPad = ev.level.toUpperCase().padEnd(5);
      const dataStr = Object.keys(ev.data).length > 0 ? ` ${JSON.stringify(ev.data)}` : "";
      console.log(`[${time}] ${levelPad} ${ev.event}${dataStr}`);
    }

    return ExitCodes.SUCCESS;
  } catch (err) {
    console.error(`Failed to retrieve logs:\n${err instanceof Error ? err.message : String(err)}`);
    return ExitCodes.ERROR;
  } finally {
    await ctx?.close().catch(() => {});
  }
}
