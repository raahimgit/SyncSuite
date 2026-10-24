import { createCliContext, type CliContext } from "../config.js";
import { ExitCodes, type ExitCode } from "../exit-codes.js";

export interface StatusCliOptions {
  db?: string;
  schema?: string;
  json?: boolean;
}

export async function runStatus(jobName?: string, options: StatusCliOptions = {}): Promise<ExitCode> {
  let ctx: CliContext | undefined;
  try {
    ctx = await createCliContext({ dbUrl: options.db, schema: options.schema });
    if (jobName) {
      const job = await ctx.store.getJobByIdOrName(jobName);
      if (!job) {
        console.error(`Job '${jobName}' not found.`);
        return ExitCodes.JOB_NOT_FOUND;
      }

      const [checkpoint, runs, deadLetters] = await Promise.all([
        ctx.store.load(job.id),
        ctx.store.listRuns(job.id, 5),
        ctx.store.listDeadLetters(job.id, { state: "open", limit: 100 }),
      ]);

      const lastRun = runs[0];

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              job,
              checkpoint,
              lastRun,
              recentRuns: runs,
              openDeadLettersCount: deadLetters.length,
            },
            null,
            2,
          ),
        );
        return ExitCodes.SUCCESS;
      }

      console.log(`Status for job: ${job.name}`);
      console.log(`  ID:            ${job.id}`);
      console.log(`  Enabled:       ${job.enabled}`);
      console.log(`  Spec Version:  ${job.specVersion}`);

      console.log("\nCheckpoint:");
      if (checkpoint) {
        console.log(`  Committed At:  ${checkpoint.committedAt.toISOString()}`);
        console.log(`  Epoch:         ${checkpoint.epoch}`);
        console.log(`  Run ID:        ${checkpoint.runId}`);
        console.log(`  Cursor:        ${JSON.stringify(checkpoint.cursor)}`);
      } else {
        console.log("  No checkpoint committed yet (not started or zero records).");
      }

      console.log("\nLast Run:");
      if (lastRun) {
        console.log(`  ID:          ${lastRun.id}`);
        console.log(`  State:       ${lastRun.state}`);
        console.log(`  Trigger:     ${lastRun.trigger}`);
        console.log(`  Dry Run:     ${lastRun.dryRun}`);
        console.log(`  Started At:  ${lastRun.startedAt.toISOString()}`);
        console.log(`  Finished At: ${lastRun.finishedAt ? lastRun.finishedAt.toISOString() : "in-progress"}`);
        console.log(`  Counters:    discovered=${lastRun.counters.discovered}, processed=${lastRun.counters.processed}, succeeded=${lastRun.counters.succeeded}, unchanged=${lastRun.counters.unchanged}, failed=${lastRun.counters.failed}`);
      } else {
        console.log("  No runs recorded yet.");
      }

      console.log(`\nOpen Dead Letters: ${deadLetters.length}`);
      return ExitCodes.SUCCESS;
    }

    // List status summary of all jobs
    const jobs = await ctx.store.listJobs();
    if (jobs.length === 0) {
      console.log("No registered jobs found.");
      return ExitCodes.SUCCESS;
    }

    const store = ctx.store;
    const summaries = await Promise.all(
      jobs.map(async (job) => {
        const [runs, dl] = await Promise.all([
          store.listRuns(job.id, 1),
          store.listDeadLetters(job.id, { state: "open", limit: 1 }),
        ]);
        return {
          name: job.name,
          enabled: job.enabled,
          version: job.specVersion,
          lastRunState: runs[0]?.state ?? "never_run",
          lastRunAt: runs[0]?.startedAt?.toISOString() ?? "n/a",
          hasOpenDeadLetters: dl.length > 0,
        };
      }),
    );

    if (options.json) {
      console.log(JSON.stringify(summaries, null, 2));
      return ExitCodes.SUCCESS;
    }

    console.log(`Job Status Overview (${summaries.length} jobs):\n`);
    for (const s of summaries) {
      const dlFlag = s.hasOpenDeadLetters ? " [OPEN DEAD LETTERS]" : "";
      console.log(`- ${s.name}: ${s.lastRunState} (last ran: ${s.lastRunAt})${dlFlag}`);
    }

    return ExitCodes.SUCCESS;
  } catch (err) {
    console.error(`Failed to get status:\n${err instanceof Error ? err.message : String(err)}`);
    return ExitCodes.ERROR;
  } finally {
    await ctx?.close().catch(() => {});
  }
}
