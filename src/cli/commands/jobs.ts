import { createCliContext, type CliContext } from "../config.js";
import { ExitCodes, type ExitCode } from "../exit-codes.js";
import { validateJobFile } from "./validate.js";

export interface JobsCliOptions {
  db?: string;
  schema?: string;
  json?: boolean;
}

export async function runJobsList(options: JobsCliOptions): Promise<ExitCode> {
  let ctx: CliContext | undefined;
  try {
    ctx = await createCliContext({ dbUrl: options.db, schema: options.schema });
    const jobs = await ctx.store.listJobs();
    if (options.json) {
      console.log(JSON.stringify(jobs, null, 2));
      return ExitCodes.SUCCESS;
    }

    if (jobs.length === 0) {
      console.log("No jobs found in database. Use 'syncsuite jobs apply <file>' to register one.");
      return ExitCodes.SUCCESS;
    }

    console.log(`Registered Jobs (${jobs.length}):\n`);
    for (const job of jobs) {
      const src = `${job.spec.source.type}`;
      const dest = `${job.spec.destination.type}`;
      const status = job.enabled ? "enabled" : "disabled";
      console.log(`- ${job.name} (v${job.specVersion}, ${status})`);
      console.log(`    Source:      ${src}`);
      console.log(`    Destination: ${dest}`);
      console.log(`    Updated:     ${job.updatedAt.toISOString()}`);
    }
    return ExitCodes.SUCCESS;
  } catch (err) {
    console.error(`Failed to list jobs:\n${err instanceof Error ? err.message : String(err)}`);
    return ExitCodes.ERROR;
  } finally {
    await ctx?.close().catch(() => {});
  }
}

export async function runJobsShow(name: string, options: JobsCliOptions): Promise<ExitCode> {
  let ctx: CliContext | undefined;
  try {
    ctx = await createCliContext({ dbUrl: options.db, schema: options.schema });
    const job = await ctx.store.getJobByIdOrName(name);
    if (!job) {
      console.error(`Job '${name}' not found.`);
      return ExitCodes.JOB_NOT_FOUND;
    }

    if (options.json) {
      console.log(JSON.stringify(job, null, 2));
    } else {
      console.log(`Job: ${job.name}`);
      console.log(`ID:      ${job.id}`);
      console.log(`Version: ${job.specVersion}`);
      console.log(`Enabled: ${job.enabled}`);
      console.log(`Created: ${job.createdAt.toISOString()}`);
      console.log(`Updated: ${job.updatedAt.toISOString()}`);
      console.log("\nSpecification:");
      console.log(JSON.stringify(job.spec, null, 2));
    }
    return ExitCodes.SUCCESS;
  } catch (err) {
    console.error(`Failed to show job:\n${err instanceof Error ? err.message : String(err)}`);
    return ExitCodes.ERROR;
  } finally {
    await ctx?.close().catch(() => {});
  }
}

export async function runJobsApply(filePath: string, options: JobsCliOptions): Promise<ExitCode> {
  const report = validateJobFile(filePath);
  if (!report.valid || !report.spec) {
    console.error(`Invalid job file '${filePath}':`);
    for (const issue of report.errors) {
      console.error(`  - ${issue}`);
    }
    return ExitCodes.VALIDATION_ERROR;
  }

  if (report.warnings.length > 0 && !options.json) {
    for (const w of report.warnings) {
      console.warn(`Warning: ${w}`);
    }
  }

  let ctx: CliContext | undefined;
  try {
    ctx = await createCliContext({ dbUrl: options.db, schema: options.schema });
    const res = await ctx.store.upsertJob(report.spec);
    if (options.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`Job '${res.job.name}' ${res.created ? "created" : "updated"} successfully.`);
      console.log(`  ID:           ${res.job.id}`);
      console.log(`  Spec Version: ${res.job.specVersion}`);
    }
    return ExitCodes.SUCCESS;
  } catch (err) {
    console.error(`Failed to apply job:\n${err instanceof Error ? err.message : String(err)}`);
    return ExitCodes.ERROR;
  } finally {
    await ctx?.close().catch(() => {});
  }
}

export async function runJobsDelete(nameOrId: string, options: JobsCliOptions): Promise<ExitCode> {
  let ctx: CliContext | undefined;
  try {
    ctx = await createCliContext({ dbUrl: options.db, schema: options.schema });
    const deleted = await ctx.store.deleteJob(nameOrId);
    if (!deleted) {
      console.error(`Job '${nameOrId}' not found.`);
      return ExitCodes.JOB_NOT_FOUND;
    }
    if (options.json) {
      console.log(JSON.stringify({ deleted: true, nameOrId }, null, 2));
    } else {
      console.log(`Job '${nameOrId}' deleted.`);
    }
    return ExitCodes.SUCCESS;
  } catch (err) {
    console.error(`Failed to delete job:\n${err instanceof Error ? err.message : String(err)}`);
    return ExitCodes.ERROR;
  } finally {
    await ctx?.close().catch(() => {});
  }
}
