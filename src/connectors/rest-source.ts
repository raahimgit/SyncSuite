import { SyncError } from "../core/types.js";
import type { Cursor, ReadBatch, SourceConnector, SourceRecord } from "../core/types.js";
import { type AuthConfig, buildAuthHeaders, classifyHttpStatus } from "./http-utils.js";
import { resolveSecret, resolveSecretsDeep } from "./secrets.js";
import { type SsrOptions, safeHttpRequest } from "./ssrf.js";

export interface RestSourcePaginationConfig {
  type?: "cursor" | "offset" | "link";
  cursorParam?: string;
  cursorResponsePath?: string;
  offsetParam?: string;
  limitParam?: string;
}

export interface RestSourceConfig {
  url: string;
  headers?: Record<string, unknown>;
  auth?: AuthConfig;
  pagination?: RestSourcePaginationConfig;
  recordsPath?: string;
  keyField?: string;
  cursorField?: string;
  timeoutMs?: number;
  allowPrivateNetworks?: boolean;
  allowHttp?: boolean;
  allowedHosts?: string[];
}

export function getByPath(obj: unknown, path: string): unknown {
  if (!path || path === ".") return obj;
  if (obj === null || obj === undefined) return undefined;

  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

export function parseNextLinkHeader(headerValue?: string): string | null {
  if (!headerValue) return null;
  // Format: <url>; rel="next"
  const match = headerValue.match(/<([^>]+)>;\s*rel=["']?next["']?/i);
  return match && match[1] ? match[1] : null;
}

export class RestSource implements SourceConnector {
  readonly type = "rest";
  private readonly config: RestSourceConfig;
  private readonly paginationType: "cursor" | "offset" | "link";
  private readonly cursorParam: string;
  private readonly cursorResponsePath?: string;
  private readonly offsetParam: string;
  private readonly limitParam?: string;
  private readonly recordsPath: string;
  private readonly keyField: string;
  private readonly cursorField?: string;
  private readonly ssrOpts: SsrOptions;

  constructor(rawConfig: Record<string, unknown>) {
    if (!rawConfig.url || typeof rawConfig.url !== "string") {
      throw new SyncError("fatal", "rest source: missing required string 'url'");
    }

    this.config = rawConfig as unknown as RestSourceConfig;
    const pag = this.config.pagination ?? {};
    this.paginationType = pag.type ?? "cursor";
    this.cursorParam = pag.cursorParam ?? "cursor";
    this.cursorResponsePath = pag.cursorResponsePath;
    this.offsetParam = pag.offsetParam ?? "offset";
    this.limitParam = pag.limitParam;

    this.recordsPath = this.config.recordsPath ?? "data";
    this.keyField = this.config.keyField ?? "id";
    this.cursorField = this.cursorField;

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
    if (this.config.auth) {
      buildAuthHeaders(this.config.auth);
    }
    if (this.config.headers) {
      resolveSecretsDeep(this.config.headers);
    }
  }

  private buildUrl(from: Cursor | null, limit: number): string {
    const rawUrl = this.config.url;

    if (this.paginationType === "link" && from?.nextUrl) {
      return String(from.nextUrl);
    }

    const url = new URL(rawUrl);

    if (this.paginationType === "offset") {
      const offset = from?.offset !== undefined ? Number(from.offset) : 0;
      url.searchParams.set(this.offsetParam, String(offset));
      if (this.limitParam) {
        url.searchParams.set(this.limitParam, String(limit));
      }
    } else if (this.paginationType === "cursor") {
      if (from?.cursor !== undefined && from.cursor !== null) {
        url.searchParams.set(this.cursorParam, String(from.cursor));
      }
      if (this.limitParam) {
        url.searchParams.set(this.limitParam, String(limit));
      }
    }

    return url.toString();
  }

  private buildHeaders(): Record<string, string> {
    const resolvedCustomHeaders: Record<string, string> = {};
    if (this.config.headers) {
      for (const [k, v] of Object.entries(this.config.headers)) {
        resolvedCustomHeaders[k] = resolveSecret(v, `header '${k}'`);
      }
    }

    const authHeaders = buildAuthHeaders(this.config.auth);
    return {
      Accept: "application/json",
      ...authHeaders,
      ...resolvedCustomHeaders,
    };
  }

  async readBatch(from: Cursor | null, limit: number, signal: AbortSignal): Promise<ReadBatch> {
    if (signal.aborted) {
      throw signal.reason ?? new Error("aborted before readBatch");
    }

    const targetUrl = this.buildUrl(from, limit);
    const headers = this.buildHeaders();

    const res = await safeHttpRequest(targetUrl, {
      method: "GET",
      headers,
      signal,
      timeoutMs: this.config.timeoutMs,
      ssrf: this.ssrOpts,
    });

    // Special classification: expired pagination token
    if ((res.status === 404 || res.status === 410) && from !== null) {
      throw new SyncError(
        "fatal",
        `REST source: pagination token expired (${res.status} ${res.statusText}); reset or re-baseline the job checkpoint`,
      );
    }

    if (res.status < 200 || res.status >= 300) {
      throw classifyHttpStatus(res.status, res.statusText, res.body, res.headers["retry-after"]);
    }

    let parsedBody: unknown;
    try {
      parsedBody = res.json();
    } catch {
      throw new SyncError("permanent", "REST source: response body is not valid JSON");
    }

    const recordsRaw = getByPath(parsedBody, this.recordsPath);
    if (!Array.isArray(recordsRaw)) {
      throw new SyncError(
        "permanent",
        `REST source: extracted path '${this.recordsPath}' is not an array (received ${typeof recordsRaw})`,
      );
    }

    if (recordsRaw.length === 0) {
      return { records: [], nextCursor: null };
    }

    const records: SourceRecord[] = recordsRaw.map((item, idx) => {
      if (item === null || typeof item !== "object") {
        throw new SyncError(
          "permanent",
          `REST source: record at index ${idx} is not an object`,
        );
      }
      const recordObj = item as Record<string, unknown>;
      const keyValue = recordObj[this.keyField];
      if (keyValue === undefined || keyValue === null) {
        throw new SyncError(
          "permanent",
          `REST source: record at index ${idx} is missing key field '${this.keyField}'`,
        );
      }
      return {
        key: String(keyValue),
        data: recordObj,
      };
    });

    let nextCursor: Cursor | null = null;

    if (this.paginationType === "cursor") {
      let cursorVal: unknown = null;
      if (this.cursorResponsePath) {
        cursorVal = getByPath(parsedBody, this.cursorResponsePath);
      } else if (this.cursorField) {
        const lastRecord = records[records.length - 1]!;
        cursorVal = lastRecord.data[this.cursorField];
      }

      if (cursorVal !== null && cursorVal !== undefined && cursorVal !== "") {
        nextCursor = { cursor: cursorVal as string | number | boolean };
      } else if (records.length < limit) {
        nextCursor = null; // Caught up
      } else {
        // Fallback: if no next cursor provided and full batch, use last key
        nextCursor = { cursor: records[records.length - 1]!.key };
      }
    }
 else if (this.paginationType === "offset") {
      const currentOffset = from?.offset !== undefined ? Number(from.offset) : 0;
      if (records.length < limit) {
        nextCursor = null; // Caught up
      } else {
        nextCursor = { offset: currentOffset + records.length };
      }
    } else if (this.paginationType === "link") {
      const nextLink = parseNextLinkHeader(res.headers.link);
      if (nextLink) {
        nextCursor = { nextUrl: nextLink };
      } else {
        nextCursor = null; // Caught up
      }
    }

    return { records, nextCursor };
  }

  async close(): Promise<void> {
    // No persistent connection pool to tear down for HTTP
  }
}
