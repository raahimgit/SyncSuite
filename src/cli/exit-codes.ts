/**
 * Exit codes used by the SyncSuite CLI.
 * Deterministic exit codes allow CI/CD pipelines, orchestrators (Airflow, Kubernetes, cron),
 * and shell scripts to distinguish success from partial failure and misconfiguration.
 */
export const ExitCodes = {
  /** Execution completed cleanly; all records processed or caught up. */
  SUCCESS: 0,

  /** General runtime failure, database connection error, or fatal runner error. */
  ERROR: 1,

  /** Run completed but some records failed and were written to dead letters. */
  PARTIAL: 2,

  /** Job specification validation failed or invalid configuration provided. */
  VALIDATION_ERROR: 3,

  /** Job was not found or is disabled. */
  JOB_NOT_FOUND: 4,

  /** Job is currently locked by another worker (active unexpired lease). */
  JOB_BUSY: 5,

  /** Command was interrupted via SIGINT or SIGTERM. */
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof ExitCodes)[keyof typeof ExitCodes];
