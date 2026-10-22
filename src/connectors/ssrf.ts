import * as dns from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { SyncError } from "../core/types.js";

export interface SsrOptions {
  allowPrivateNetworks?: boolean;
  allowHttp?: boolean;
  allowedHosts?: string[];
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  json<T = unknown>(): T;
}

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  ssrf?: SsrOptions;
}

/**
 * Checks if an IPv4 address falls into private, loopback, link-local,
 * carrier-grade NAT, test-net, or multicast/reserved ranges.
 */
export function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    return true; // Malformed IPv4 is treated as unsafe
  }
  const [a, b, c] = parts;
  if (a === undefined || b === undefined || c === undefined) return true;

  // 0.0.0.0/8 (Current network)
  if (a === 0) return true;
  // 10.0.0.0/8 (Private)
  if (a === 10) return true;
  // 100.64.0.0/10 (Carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-local & cloud metadata)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (Private)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 & 192.0.2.0/24 (IETF protocol & TEST-NET-1)
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  // 192.168.0.0/16 (Private)
  if (a === 192 && b === 168) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved) & 255.255.255.255
  if (a >= 224) return true;

  return false;
}


/**
 * Checks if an IPv6 address falls into loopback, unique local,
 * link-local, multicast, or IPv4-mapped private ranges.
 */
export function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // ::1 loopback
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  // :: unspecified
  if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return true;

  // IPv4-mapped IPv6 (e.g. ::ffff:192.168.1.1)
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon !== -1) {
      const v4Part = normalized.slice(lastColon + 1);
      if (net.isIPv4(v4Part)) {
        return isPrivateOrReservedIpv4(v4Part);
      }
    }
  }

  // fc00::/7 (Unique local)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  // fe80::/10 (Link-local)
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }
  // ff00::/8 (Multicast)
  if (normalized.startsWith("ff")) return true;

  return false;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateOrReservedIpv4(ip);
  if (version === 6) return isPrivateOrReservedIpv6(ip);
  return true; // Not a valid IP -> consider unsafe
}

/**
 * Validates a target URL against SSRF policy rules.
 */
export function validateUrl(rawUrl: string, options: SsrOptions = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SyncError("fatal", "invalid URL format");
  }

  // Protocol check
  if (parsed.protocol === "http:") {
    if (!options.allowHttp) {
      throw new SyncError("fatal", "SSRF policy violation: http:// is not allowed; https:// is required");
    }
  } else if (parsed.protocol !== "https:") {
    throw new SyncError("fatal", `SSRF policy violation: unsupported protocol '${parsed.protocol}'`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Host allowlist check
  if (options.allowedHosts && options.allowedHosts.length > 0) {
    const isAllowed = options.allowedHosts.some((h) => h.toLowerCase() === hostname);
    if (!isAllowed) {
      throw new SyncError("fatal", `SSRF policy violation: host '${hostname}' is not in allowedHosts list`);
    }
  }

  // Known cloud metadata hostnames
  const forbiddenHostnames = ["metadata.google.internal", "instance-data"];
  if (forbiddenHostnames.includes(hostname) && !options.allowPrivateNetworks) {
    throw new SyncError("fatal", `SSRF policy violation: access to metadata host '${hostname}' is forbidden`);
  }

  return parsed;
}

/**
 * Resolves a hostname to IP addresses and checks every IP against the SSRF policy.
 * Returns the first valid IP address to pin the connection to.
 */
export async function resolveAndValidateHost(
  hostname: string,
  options: SsrOptions = {},
): Promise<string> {
  // If the hostname is already an IP address, validate it directly
  if (net.isIP(hostname)) {
    if (!options.allowPrivateNetworks && isPrivateOrReservedIp(hostname)) {
      throw new SyncError("fatal", `SSRF policy violation: target IP address '${hostname}' is in a private or reserved range`);
    }
    return hostname;
  }

  if (hostname === "localhost" && !options.allowPrivateNetworks) {
    throw new SyncError("fatal", "SSRF policy violation: 'localhost' is in a private or reserved range");
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (err) {
    throw new SyncError("transient", `DNS lookup failed for host '${hostname}'`, { cause: err });
  }

  if (!addresses || addresses.length === 0) {
    throw new SyncError("transient", `no DNS records found for host '${hostname}'`);
  }

  // Validate every resolved IP
  if (!options.allowPrivateNetworks) {
    for (const record of addresses) {
      if (isPrivateOrReservedIp(record.address)) {
        throw new SyncError(
          "fatal",
          `SSRF policy violation: host '${hostname}' resolved to private/reserved IP address '${record.address}'`,
        );
      }
    }
  }

  // Return the first resolved IP
  return addresses[0]!.address;
}


/**
 * Dispatches a safe HTTP/HTTPS request with DNS pre-resolution and IP pinning,
 * preventing DNS rebinding and SSRF attacks.
 */
export function safeHttpRequest(
  rawUrl: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse> {
  const ssrOpts = options.ssrf ?? {};
  const url = validateUrl(rawUrl, ssrOpts);

  return new Promise<HttpResponse>((resolve, reject) => {
    // Check if aborted before even starting
    if (options.signal?.aborted) {
      return reject(options.signal.reason ?? new Error("request aborted"));
    }

    resolveAndValidateHost(url.hostname, ssrOpts)
      .then((resolvedIp) => {
        const isHttps = url.protocol === "https:";
        const client = isHttps ? https : http;

        const port = url.port ? Number.parseInt(url.port, 10) : isHttps ? 443 : 80;

        const headers: Record<string, string> = {
          Host: url.host,
          Accept: "application/json, */*",
          ...options.headers,
        };

        const timeoutMs = options.timeoutMs ?? ssrOpts.timeoutMs ?? 30_000;

        // Custom lookup function that returns the pre-validated resolved IP.
        // This pins the connection to the validated IP and prevents DNS rebinding.
        const pinnedLookup = (
          _host: string,
          _lookupOpts: unknown,
          cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
        ) => {
          const family = net.isIPv6(resolvedIp) ? 6 : 4;
          cb(null, resolvedIp, family);
        };

        const reqOptions: http.RequestOptions = {
          hostname: url.hostname,
          port,
          path: `${url.pathname}${url.search}`,
          method: options.method ?? "GET",
          headers,
          lookup: pinnedLookup,
          timeout: timeoutMs,
        };

        // For HTTPS, SNI servername must match the hostname
        if (isHttps) {
          (reqOptions as https.RequestOptions).servername = url.hostname;
        }

        const req = client.request(reqOptions, (res) => {
          const chunks: Buffer[] = [];

          res.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });

          res.on("end", () => {
            const bodyBuffer = Buffer.concat(chunks);
            const bodyStr = bodyBuffer.toString("utf8");

            const responseHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (v !== undefined) {
                responseHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
              }
            }

            const response: HttpResponse = {
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? "",
              headers: responseHeaders,
              body: bodyStr,
              json<T = unknown>(): T {
                try {
                  return JSON.parse(bodyStr) as T;
                } catch (parseErr) {
                  throw new SyncError("permanent", "failed to parse response as JSON", { cause: parseErr });
                }
              },
            };

            resolve(response);
          });
        });

        // Wire abort signal
        let onAbort: (() => void) | undefined;
        if (options.signal) {
          onAbort = () => {
            req.destroy(options.signal?.reason ?? new Error("request aborted"));
          };
          options.signal.addEventListener("abort", onAbort, { once: true });
        }


        req.on("timeout", () => {
          req.destroy(new SyncError("transient", `request timed out after ${timeoutMs}ms`));
        });

        req.on("error", (err) => {
          if (onAbort && options.signal) {
            options.signal.removeEventListener("abort", onAbort);
          }
          if (err instanceof SyncError) {
            reject(err);
          } else if ((err as { code?: string }).code === "ECONNREFUSED") {
            reject(new SyncError("transient", `connection refused to ${url.hostname}`, { cause: err }));
          } else if ((err as { code?: string }).code === "ETIMEDOUT") {
            reject(new SyncError("transient", `connection timed out to ${url.hostname}`, { cause: err }));
          } else {
            reject(new SyncError("transient", `network error: ${err.message}`, { cause: err }));
          }
        });

        if (options.body) {
          req.write(options.body);
        }

        req.end();
      })
      .catch((err) => {
        reject(err instanceof SyncError ? err : new SyncError("fatal", String(err)));
      });
  });
}
