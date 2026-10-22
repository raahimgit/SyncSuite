import type { JobSpec } from "../core/job-spec.js";
import type { DeadLetter, Job, Run, RunEvent } from "../db/store.js";
import type {
  DeadLetterRetryRequest,
  DeadLetterRetryResponse,
  HealthResponse,
  StopRunResponse,
  TriggerRunRequest,
  TriggerRunResponse,
} from "../api/types.js";

export class SyncSuiteApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly body: unknown,
    message?: string,
  ) {
    const detailMsg =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : message ?? `HTTP ${status}`;
    super(`SyncSuite API request to ${endpoint} failed (${status}): ${detailMsg}`);
    this.name = "SyncSuiteApiError";
  }
}

export interface ClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export class SyncSuiteClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly customFetch: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.customFetch = options.fetch ?? globalThis.fetch;
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      params?: Record<string, string | number | boolean | undefined>;
    } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (options.params) {
      for (const [key, val] of Object.entries(options.params)) {
        if (val !== undefined) url.searchParams.set(key, String(val));
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    let requestBody: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(options.body);
    }

    const res = await this.customFetch(url.toString(), {
      method: options.method ?? "GET",
      headers,
      body: requestBody,
    });

    if (res.status === 204) {
      return undefined as T;
    }

    const contentType = res.headers.get("content-type") ?? "";
    const isJson = contentType.includes("application/json");

    if (!res.ok) {
      const errBody = isJson ? await res.json().catch(() => null) : await res.text().catch(() => "");
      throw new SyncSuiteApiError(res.status, path, errBody);
    }

    return (isJson ? await res.json() : await res.text()) as T;
  }

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("/health");
  }

  async getOpenApi(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/openapi.json");
  }

  async listJobs(): Promise<Job[]> {
    return this.request<Job[]>("/jobs");
  }

  async createJob(spec: JobSpec): Promise<Job> {
    return this.request<Job>("/jobs", {
      method: "POST",
      body: { spec },
    });
  }

  async getJob(idOrName: string): Promise<Job> {
    return this.request<Job>(`/jobs/${encodeURIComponent(idOrName)}`);
  }

  async updateJob(idOrName: string, spec: JobSpec): Promise<Job> {
    return this.request<Job>(`/jobs/${encodeURIComponent(idOrName)}`, {
      method: "PUT",
      body: { spec },
    });
  }

  async deleteJob(idOrName: string): Promise<void> {
    await this.request<void>(`/jobs/${encodeURIComponent(idOrName)}`, {
      method: "DELETE",
    });
  }

  async triggerRun(idOrName: string, options: TriggerRunRequest = {}): Promise<TriggerRunResponse> {
    return this.request<TriggerRunResponse>(`/jobs/${encodeURIComponent(idOrName)}/runs`, {
      method: "POST",
      body: options,
    });
  }

  async listRuns(idOrName: string, options: { limit?: number } = {}): Promise<Run[]> {
    return this.request<Run[]>(`/jobs/${encodeURIComponent(idOrName)}/runs`, {
      params: { limit: options.limit },
    });
  }

  async getRun(runId: string): Promise<Run> {
    return this.request<Run>(`/runs/${encodeURIComponent(runId)}`);
  }

  async stopRun(runId: string): Promise<StopRunResponse> {
    return this.request<StopRunResponse>(`/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
    });
  }

  async getRunEvents(runId: string, options: { limit?: number } = {}): Promise<RunEvent[]> {
    return this.request<RunEvent[]>(`/runs/${encodeURIComponent(runId)}/events`, {
      params: { limit: options.limit },
    });
  }

  async listDeadLetters(
    idOrName: string,
    options: { state?: "open" | "retrying" | "resolved"; limit?: number } = {},
  ): Promise<DeadLetter[]> {
    return this.request<DeadLetter[]>(`/jobs/${encodeURIComponent(idOrName)}/dead-letters`, {
      params: { state: options.state, limit: options.limit },
    });
  }

  async getDeadLetter(id: string): Promise<DeadLetter> {
    return this.request<DeadLetter>(`/dead-letters/${encodeURIComponent(id)}`);
  }

  async retryDeadLetters(idOrName: string, options: DeadLetterRetryRequest = {}): Promise<DeadLetterRetryResponse> {
    return this.request<DeadLetterRetryResponse>(`/jobs/${encodeURIComponent(idOrName)}/retry`, {
      method: "POST",
      body: options,
    });
  }
}

// Convenient alias matching product naming
export const SyncKitClient = SyncSuiteClient;
