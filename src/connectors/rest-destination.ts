import { SyncError } from "../core/types.js";
import type { DestinationConnector, PlannedWrite, WriteRequest, WriteResult } from "../core/types.js";
import { type AuthConfig, buildAuthHeaders, classifyHttpStatus } from "./http-utils.js";
import { resolveSecret, resolveSecretsDeep } from "./secrets.js";
import { type SsrOptions, safeHttpRequest } from "./ssrf.js";

export interface RestDestinationConfig {
  url: string;
  method?: "PUT" | "POST" | "PATCH";
  headers?: Record<string, unknown>;
  auth?: AuthConfig;
  idempotencyHeader?: string;
  keyDerivedUrl?: boolean;
  timeoutMs?: number;
  allowPrivateNetworks?: boolean;
  allowHttp?: boolean;
  allowedHosts?: string[];
}

export class RestDestination implements DestinationConnector {
  readonly type = "rest";
  private readonly config: RestDestinationConfig;
  private readonly method: string;
  private readonly idempotencyHeader: string;
  private readonly keyDerivedUrl: boolean;
  private readonly ssrOpts: SsrOptions;

  constructor(rawConfig: Record<string, unknown>) {
    if (!rawConfig.url || typeof rawConfig.url !== "string") {
      throw new SyncError("fatal", "rest destination: missing required string 'url'");
    }

    this.config = rawConfig as unknown as RestDestinationConfig;
    this.method = (this.config.method ?? (this.config.keyDerivedUrl ? "PUT" : "POST")).toUpperCase();
    this.idempotencyHeader = this.config.idempotencyHeader ?? "Idempotency-Key";
    this.keyDerivedUrl = Boolean(this.config.keyDerivedUrl);

    this.ssrOpts = {
      allowPrivateNetworks: Boolean(this.config.allowPrivateNetworks),
      allowHttp: Boolean(this.config.allowHttp),
      allowedHosts: this.config.allowedHosts,
      timeoutMs: this.config.timeoutMs ?? 30_000,
    };
  }

  async open(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw signal.reason ?? new Error("aborted before open");
    }
    // Verify secret resolution on open so misconfigurations fail fast
    if (this.config.auth) {
      buildAuthHeaders(this.config.auth);
    }
    if (this.config.headers) {
      resolveSecretsDeep(this.config.headers);
    }
  }

  private resolveUrl(key: string): string {
    const baseUrl = this.config.url;
    if (this.keyDerivedUrl) {
      const cleanBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
      return `${cleanBase}/${encodeURIComponent(key)}`;
    }
    return baseUrl;
  }

  private buildHeaders(idempotencyKey: string): Record<string, string> {
    const resolvedCustomHeaders: Record<string, string> = {};
    if (this.config.headers) {
      for (const [k, v] of Object.entries(this.config.headers)) {
        resolvedCustomHeaders[k] = resolveSecret(v, `header '${k}'`);
      }
    }

    const authHeaders = buildAuthHeaders(this.config.auth);

    return {
      "Content-Type": "application/json",
      [this.idempotencyHeader]: idempotencyKey,
      ...authHeaders,
      ...resolvedCustomHeaders,
    };
  }

  async write(req: WriteRequest, signal: AbortSignal): Promise<WriteResult> {
    if (signal.aborted) {
      throw signal.reason ?? new Error("aborted before write");
    }

    const targetUrl = this.resolveUrl(req.key);
    const headers = this.buildHeaders(req.idempotencyKey);
    const body = JSON.stringify(req.data);

    const res = await safeHttpRequest(targetUrl, {
      method: this.method,
      headers,
      body,
      signal,
      timeoutMs: this.config.timeoutMs,
      ssrf: this.ssrOpts,
    });

    if (res.status >= 200 && res.status < 300) {
      return { status: "written" };
    }

    if (res.status === 304) {
      return { status: "unchanged" };
    }

    throw classifyHttpStatus(
      res.status,
      res.statusText,
      res.body,
      res.headers["retry-after"],
    );
  }

  async plan(req: WriteRequest, signal: AbortSignal): Promise<PlannedWrite> {
    if (signal.aborted) {
      throw signal.reason ?? new Error("aborted before plan");
    }


    const targetUrl = this.resolveUrl(req.key);
    return {
      action: "unknown",
      description: `${this.method} ${targetUrl} (Idempotency-Key: ${req.idempotencyKey}, payload keys: ${Object.keys(req.data).join(", ")})`,
    };
  }

  async close(): Promise<void> {
    // No persistent connection pool to tear down for HTTP
  }
}
