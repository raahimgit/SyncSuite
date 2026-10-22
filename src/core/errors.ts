export class JobNotFoundError extends Error {
  constructor(readonly jobName: string) {
    super(`job not found: ${jobName}`);
    this.name = "JobNotFoundError";
  }
}

export class JobDisabledError extends Error {
  constructor(readonly jobName: string) {
    super(`job is disabled: ${jobName}`);
    this.name = "JobDisabledError";
  }
}

export class JobBusyError extends Error {
  constructor(readonly jobName: string) {
    super(`job '${jobName}' already has an active run`);
    this.name = "JobBusyError";
  }
}

export class DuplicateJobError extends Error {
  constructor(readonly jobName: string) {
    super(`a job named '${jobName}' already exists`);
    this.name = "DuplicateJobError";
  }
}

// Raised when a worker's lease epoch is no longer the job's current epoch.
// The worker must stop immediately: another worker owns the job.
export class LeaseLostError extends Error {
  constructor(readonly subject: string) {
    super(`lease lost for '${subject}': another worker took over`);
    this.name = "LeaseLostError";
  }
}
