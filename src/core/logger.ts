export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface Logger {
  debug(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
  child?(bindings: Record<string, unknown>): Logger;
  addRedactValue?(secret: string): void;
}

export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
  addRedactValue() {},
};

export interface JsonLoggerOptions {
  level?: LogLevel;
  redactKeys?: string[];
  redactValues?: string[];
  writer?: (line: string) => void;
  context?: Record<string, unknown>;
  clock?: () => Date;
}

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

const DEFAULT_REDACT_KEYS = [
  "password",
  "secret",
  "token",
  "authorization",
  "cookie",
  "apikey",
  "api_key",
  "privatekey",
  "private_key",
  "authkey",
  "auth_key",
  "credential",
  "credentials",
  "access_token",
  "refresh_token",
];

// Regex matching URLs with user:password@ credentials
const URL_CREDENTIAL_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:]+):([^@]+)@/g;

// Regex matching Authorization header values: Bearer <token>, Basic <base64>, Token <token>
const AUTH_HEADER_PATTERN = /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/-]+=*)/gi;

export class RedactionFilter {
  private readonly sensitiveKeys: Set<string>;
  private readonly secretStrings: Set<string>;

  constructor(additionalKeys: string[] = [], initialSecrets: string[] = []) {
    this.sensitiveKeys = new Set(
      [...DEFAULT_REDACT_KEYS, ...additionalKeys].map((k) => k.toLowerCase()),
    );
    this.secretStrings = new Set();
    for (const s of initialSecrets) {
      this.addSecret(s);
    }
  }

  addSecret(secret: string): void {
    if (typeof secret === "string" && secret.trim().length >= 3) {
      this.secretStrings.add(secret.trim());
    }
  }

  redactString(text: string): string {
    if (!text) return text;
    let result = text;

    // 1. Redact URL credentials: postgres://user:pass@host -> postgres://user:[REDACTED]@host
    result = result.replace(URL_CREDENTIAL_PATTERN, "$1$2:[REDACTED]@");

    // 2. Redact Authorization header values: Bearer xyz -> Bearer [REDACTED]
    result = result.replace(AUTH_HEADER_PATTERN, "$1 [REDACTED]");

    // 3. Redact explicit secret strings registered
    for (const secret of this.secretStrings) {
      if (result.includes(secret)) {
        result = result.replaceAll(secret, "[REDACTED]");
      }
    }

    return result;
  }

  redactValue(val: unknown, keyName?: string): unknown {
    if (val === null || val === undefined) {
      return val;
    }

    // Check if key name indicates sensitive field
    if (keyName && this.isSensitiveKey(keyName)) {
      return "[REDACTED]";
    }

    if (typeof val === "string") {
      return this.redactString(val);
    }

    if (typeof val === "number" || typeof val === "boolean") {
      return val;
    }

    if (val instanceof Error) {
      return this.redactError(val);
    }

    if (Array.isArray(val)) {
      return val.map((item) => this.redactValue(item));
    }

    if (typeof val === "object") {
      const sanitized: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (this.isSensitiveKey(k)) {
          sanitized[k] = "[REDACTED]";
        } else {
          sanitized[k] = this.redactValue(v, k);
        }
      }
      return sanitized;
    }

    return val;
  }

  private isSensitiveKey(key: string): boolean {
    const lower = key.toLowerCase();
    if (
      lower === "keycolumn" ||
      lower === "cursorcolumn" ||
      lower === "idempotencykeyheader" ||
      lower === "keyderivedurl"
    ) {
      return false;
    }
    for (const sensitive of this.sensitiveKeys) {
      if (lower.includes(sensitive)) {
        return true;
      }
    }
    return false;
  }

  redactError(err: Error): Record<string, unknown> {
    const errorRecord: Record<string, unknown> = {
      name: err.name,
      message: this.redactString(err.message),
    };

    if (err.stack) {
      errorRecord.stack = this.redactString(err.stack);
    }

    if ("cause" in err && err.cause) {
      errorRecord.cause = this.redactValue(err.cause);
    }

    // Capture extra custom properties on Error (e.g. SyncError.kind, code, etc.)
    for (const [k, v] of Object.entries(err)) {
      if (k !== "name" && k !== "message" && k !== "stack") {
        errorRecord[k] = this.redactValue(v, k);
      }
    }

    return errorRecord;
  }
}

export class JsonLogger implements Logger {
  private levelSeverity: number;
  private readonly redactionFilter: RedactionFilter;
  private readonly writer: (line: string) => void;
  private readonly baseContext: Record<string, unknown>;
  private readonly clock: () => Date;

  constructor(options: JsonLoggerOptions = {}) {
    const envLevel = (process.env.LOG_LEVEL?.toLowerCase() as LogLevel) || "info";
    const level = options.level ?? envLevel;
    this.levelSeverity = LEVEL_SEVERITY[level] ?? LEVEL_SEVERITY.info;
    this.redactionFilter = new RedactionFilter(options.redactKeys, options.redactValues);
    this.writer =
      options.writer ??
      ((line: string) => {
        process.stdout.write(line + "\n");
      });
    this.baseContext = options.context ?? {};
    this.clock = options.clock ?? (() => new Date());
  }

  setLevel(level: LogLevel): void {
    this.levelSeverity = LEVEL_SEVERITY[level] ?? LEVEL_SEVERITY.info;
  }

  addRedactValue(secret: string): void {
    this.redactionFilter.addSecret(secret);
  }

  child(bindings: Record<string, unknown>): JsonLogger {
    const childLogger = new JsonLogger({
      level: this.getCurrentLevel(),
      writer: this.writer,
      clock: this.clock,
      context: { ...this.baseContext, ...bindings },
    });
    // Share the redaction filter
    (childLogger as unknown as { redactionFilter: RedactionFilter }).redactionFilter =
      this.redactionFilter;
    return childLogger;
  }

  private getCurrentLevel(): LogLevel {
    for (const [lvl, sev] of Object.entries(LEVEL_SEVERITY)) {
      if (sev === this.levelSeverity) return lvl as LogLevel;
    }
    return "info";
  }

  private log(level: "debug" | "info" | "warn" | "error", event: string, data?: Record<string, unknown>): void {
    if (LEVEL_SEVERITY[level] < this.levelSeverity) {
      return;
    }

    const payload: Record<string, unknown> = {
      timestamp: this.clock().toISOString(),
      level,
      event,
      ...this.baseContext,
    };

    if (data) {
      for (const [k, v] of Object.entries(data)) {
        payload[k] = this.redactionFilter.redactValue(v, k);
      }
    }

    try {
      this.writer(JSON.stringify(payload));
    } catch {
      // Fallback in case of circular structure
      const fallback: Record<string, unknown> = {
        timestamp: this.clock().toISOString(),
        level,
        event,
        raw_error: "Serialization failed",
      };
      this.writer(JSON.stringify(fallback));
    }
  }

  debug(event: string, data?: Record<string, unknown>): void {
    this.log("debug", event, data);
  }

  info(event: string, data?: Record<string, unknown>): void {
    this.log("info", event, data);
  }

  warn(event: string, data?: Record<string, unknown>): void {
    this.log("warn", event, data);
  }

  error(event: string, data?: Record<string, unknown>): void {
    this.log("error", event, data);
  }
}

export function createJsonLogger(options?: JsonLoggerOptions): JsonLogger {
  return new JsonLogger(options);
}
