import { SyncError } from "../core/types.js";
import { resolveSecret } from "./secrets.js";

export type AuthConfig =
  | { type: "bearer"; token: unknown }
  | { type: "basic"; username: unknown; password: unknown }
  | { type: "apiKey"; header: string; key: unknown };

/**
 * Resolves authentication headers from configuration and environment secrets.
 */
export function buildAuthHeaders(auth?: AuthConfig): Record<string, string> {
  if (!auth) return {};

  if (auth.type === "bearer") {
    const token = resolveSecret(auth.token, "bearer token");
    return { Authorization: `Bearer ${token}` };
  }

  if (auth.type === "basic") {
    const username = resolveSecret(auth.username, "basic username");
    const password = resolveSecret(auth.password, "basic password");
    const encoded = Buffer.from(`${username}:${password}`).toString("base64");
    return { Authorization: `Basic ${encoded}` };
  }

  if (auth.type === "apiKey") {
    const key = resolveSecret(auth.key, "apiKey");
    return { [auth.header]: key };
  }

  throw new SyncError("fatal", `unsupported auth type '${(auth as { type: string }).type}'`);
}

/**
 * Parses HTTP Retry-After header into milliseconds.
 * Supports delta-seconds ("120") and HTTP-date formats.
 */
export function parseRetryAfter(headerValue?: string): number | undefined {
  if (!headerValue || !headerValue.trim()) return undefined;

  const trimmed = headerValue.trim();
  const seconds = Number.parseFloat(trimmed);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  // Try HTTP-date format
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    const deltaMs = parsedDate - Date.now();
    return deltaMs > 0 ? deltaMs : 0;
  }

  return undefined;
}

/**
 * Maps HTTP status codes to SyncError error kinds:
 * - 400, 422: permanent (client/validation rejection)
 * - 401, 403: fatal (authentication / authorization failure)
 * - 408: transient (request timeout)
 * - 429: rate_limited
 * - 500, 502, 503, 504: transient (server error)
 * - other 4xx: permanent
 * - other 5xx: transient
 */
export function classifyHttpStatus(
  status: number,
  statusText: string,
  bodyText: string,
  retryAfterHeader?: string,
): SyncError {
  const retryAfterMs = parseRetryAfter(retryAfterHeader);
  const truncatedBody = bodyText.length > 500 ? `${bodyText.slice(0, 500)}...` : bodyText;
  const message = `HTTP ${status} ${statusText}: ${truncatedBody}`;

  if (status === 401 || status === 403) {
    return new SyncError("fatal", message);
  }

  if (status === 429) {
    return new SyncError("rate_limited", message, { retryAfterMs });
  }

  if (status === 408) {
    return new SyncError("transient", message, { retryAfterMs });
  }

  if (status >= 500 && status < 600) {
    return new SyncError("transient", message, { retryAfterMs });
  }

  if (status >= 400 && status < 500) {
    return new SyncError("permanent", message);
  }

  return new SyncError("transient", message);
}
