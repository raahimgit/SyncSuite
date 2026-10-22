import { createHash, createHmac } from "node:crypto";
import { SyncError } from "../core/types.js";
import type { DestinationConnector, PlannedWrite, WriteRequest, WriteResult } from "../core/types.js";
import { classifyHttpStatus } from "./http-utils.js";
import { resolveSecret } from "./secrets.js";
import { type SsrOptions, safeHttpRequest } from "./ssrf.js";

export interface S3DestinationConfig {
  bucket: string;
  region?: string;
  endpoint?: string;
  prefix?: string;
  accessKeyId: unknown;
  secretAccessKey: unknown;
  sessionToken?: unknown;
  keyDerivedPath?: boolean;
  format?: "json" | "ndjson";
  timeoutMs?: number;
  allowPrivateNetworks?: boolean;
}

export function signAwsV4(params: {
  method: string;
  url: URL;
  body: string | Buffer;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service?: string;
  date?: Date;
}): Record<string, string> {
  const d = params.date ?? new Date();
  const amzDate = d.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const service = params.service ?? "s3";

  const payloadHash = createHash("sha256").update(params.body).digest("hex");
  const host = params.url.host;

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  if (params.sessionToken) {
    headers["x-amz-security-token"] = params.sessionToken;
  }

  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k.toLowerCase()}:${headers[k]}\n`).join("");
  const signedHeaders = sortedHeaderKeys.map((k) => k.toLowerCase()).join(";");

  const canonicalUri = params.url.pathname || "/";
  const canonicalQuery = Array.from(params.url.searchParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalRequest = [
    params.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${params.region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest();
  const kDate = hmac(`AWS4${params.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, params.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    ...headers,
    Authorization: authorization,
  };
}

export class S3Destination implements DestinationConnector {
  readonly type = "s3";
  private readonly config: S3DestinationConfig;
  private readonly bucket: string;
  private readonly region: string;
  private readonly prefix: string;
  private readonly keyDerivedPath: boolean;
  private readonly format: "json" | "ndjson";
  private readonly ssrOpts: SsrOptions;

  constructor(rawConfig: Record<string, unknown>) {
    if (!rawConfig.bucket || typeof rawConfig.bucket !== "string") {
      throw new SyncError("fatal", "s3 destination: missing required string 'bucket'");
    }
    if (!rawConfig.accessKeyId) {
      throw new SyncError("fatal", "s3 destination: missing required 'accessKeyId'");
    }
    if (!rawConfig.secretAccessKey) {
      throw new SyncError("fatal", "s3 destination: missing required 'secretAccessKey'");
    }

    this.config = rawConfig as unknown as S3DestinationConfig;
    this.bucket = this.config.bucket;
    this.region = this.config.region ?? "us-east-1";
    let p = this.config.prefix ?? "";
    if (p && !p.endsWith("/")) {
      p += "/";
    }
    this.prefix = p;
    this.keyDerivedPath = this.config.keyDerivedPath !== false;
    this.format = this.config.format === "ndjson" ? "ndjson" : "json";

    this.ssrOpts = {
      allowPrivateNetworks: Boolean(this.config.allowPrivateNetworks),
      allowHttp: Boolean(this.config.endpoint?.startsWith("http://")),
      timeoutMs: this.config.timeoutMs ?? 30_000,
    };
  }

  async open(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw signal.reason ?? new Error("aborted before open");
    }
    // Verify credential resolution on open so misconfigurations fail fast
    resolveSecret(this.config.accessKeyId, "accessKeyId");
    resolveSecret(this.config.secretAccessKey, "secretAccessKey");
    if (this.config.sessionToken) {
      resolveSecret(this.config.sessionToken, "sessionToken");
    }
  }

  private resolveObjectKey(recordKey: string): string {
    if (this.keyDerivedPath) {
      const ext = this.format === "ndjson" ? "ndjson" : "json";
      return `${this.prefix}${recordKey}.${ext}`;
    }
    return `${this.prefix}${recordKey}`;
  }

  private resolveUrl(objectKey: string): URL {
    if (this.config.endpoint) {
      const base = this.config.endpoint.endsWith("/") ? this.config.endpoint.slice(0, -1) : this.config.endpoint;
      return new URL(`${base}/${this.bucket}/${encodeURIComponent(objectKey).replace(/%2F/g, "/")}`);
    }
    return new URL(`https://${this.bucket}.s3.${this.region}.amazonaws.com/${encodeURIComponent(objectKey).replace(/%2F/g, "/")}`);
  }

  async write(req: WriteRequest, signal: AbortSignal): Promise<WriteResult> {
    if (signal.aborted) {
      throw signal.reason ?? new Error("aborted before write");
    }

    const objectKey = this.resolveObjectKey(req.key);
    const targetUrl = this.resolveUrl(objectKey);
    const body = this.format === "ndjson"
      ? `${JSON.stringify(req.data)}\n`
      : JSON.stringify(req.data, null, 2);

    const accessKeyId = resolveSecret(this.config.accessKeyId, "accessKeyId");
    const secretAccessKey = resolveSecret(this.config.secretAccessKey, "secretAccessKey");
    const sessionToken = this.config.sessionToken ? resolveSecret(this.config.sessionToken, "sessionToken") : undefined;

    const signedHeaders = signAwsV4({
      method: "PUT",
      url: targetUrl,
      body,
      accessKeyId,
      secretAccessKey,
      sessionToken,
      region: this.region,
    });

    const contentType = this.format === "ndjson" ? "application/x-ndjson" : "application/json";

    const res = await safeHttpRequest(targetUrl.toString(), {
      method: "PUT",
      headers: {
        ...signedHeaders,
        "Content-Type": contentType,
      },
      body,
      signal,
      timeoutMs: this.config.timeoutMs,
      ssrf: this.ssrOpts,
    });

    if (res.status >= 200 && res.status < 300) {
      return { status: "written" };
    }

    throw classifyHttpStatus(res.status, res.statusText, res.body, res.headers["retry-after"]);
  }

  async plan(req: WriteRequest, signal: AbortSignal): Promise<PlannedWrite> {
    if (signal.aborted) {
      throw signal.reason ?? new Error("aborted before plan");
    }

    const objectKey = this.resolveObjectKey(req.key);
    const targetUrl = this.resolveUrl(objectKey);

    const accessKeyId = resolveSecret(this.config.accessKeyId, "accessKeyId");
    const secretAccessKey = resolveSecret(this.config.secretAccessKey, "secretAccessKey");
    const sessionToken = this.config.sessionToken ? resolveSecret(this.config.sessionToken, "sessionToken") : undefined;

    const signedHeaders = signAwsV4({
      method: "HEAD",
      url: targetUrl,
      body: "",
      accessKeyId,
      secretAccessKey,
      sessionToken,
      region: this.region,
    });

    try {
      const res = await safeHttpRequest(targetUrl.toString(), {
        method: "HEAD",
        headers: signedHeaders,
        signal,
        timeoutMs: this.config.timeoutMs,
        ssrf: this.ssrOpts,
      });

      if (res.status === 200) {
        return {
          action: "update",
          description: `S3 object 's3://${this.bucket}/${objectKey}' exists and will be overwritten`,
        };
      }
      if (res.status === 404) {
        return {
          action: "create",
          description: `S3 object 's3://${this.bucket}/${objectKey}' does not exist and will be created`,
        };
      }
      return {
        action: "unknown",
        description: `S3 returned status ${res.status} for 's3://${this.bucket}/${objectKey}'`,
      };
    } catch {
      return {
        action: "unknown",
        description: `Cannot determine S3 object status for 's3://${this.bucket}/${objectKey}'`,
      };
    }
  }

  async close(): Promise<void> {}
}
