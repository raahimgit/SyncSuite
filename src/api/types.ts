import type { JobSpec } from "../core/job-spec.js";
import type { RunCounters, RunError, RunState, RunTrigger } from "../core/types.js";

export interface ApiServerOptions {
  port?: number;
  host?: string;
  dbUrl?: string;
  schema?: string;
  bearerToken?: string;
}

export interface ApiErrorResponse {
  error: string;
  details?: unknown;
}

export interface HealthResponse {
  status: "ok" | "error";
  database: "connected" | "disconnected";
  version: string;
  uptimeSeconds: number;
}

export interface CreateJobRequest {
  spec: JobSpec;
}

export interface UpdateJobRequest {
  spec: JobSpec;
}

export interface TriggerRunRequest {
  trigger?: RunTrigger;
  dryRun?: boolean;
  maxRecords?: number;
  /** If true, creates a pending run in the queue rather than waiting for completion or running synchronously. */
  queued?: boolean;
}

export interface TriggerRunResponse {
  runId: string;
  state: RunState;
  counters?: RunCounters;
  error?: RunError;
}

export interface StopRunResponse {
  runId: string;
  stopped: boolean;
  message: string;
}

export interface DeadLetterRetryRequest {
  ids?: string[];
  limit?: number;
}

export interface DeadLetterRetryResponse {
  processed: number;
  resolved: number;
  failed: number;
}
