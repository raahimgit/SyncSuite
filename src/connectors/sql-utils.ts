import { SyncError } from "../core/types.js";

const IDENTIFIER_PART_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validates and quotes an SQL identifier (supports schema-qualified like "public.users").
 * Throws a fatal SyncError if any identifier part contains illegal characters.
 */
export function quoteIdentifier(ident: string): string {
  if (!ident || typeof ident !== "string") {
    throw new SyncError("fatal", "invalid SQL identifier: empty identifier");
  }

  const parts = ident.split(".");
  for (const part of parts) {
    if (!IDENTIFIER_PART_REGEX.test(part)) {
      throw new SyncError(
        "fatal",
        `invalid SQL identifier '${ident}': part '${part}' contains forbidden characters`,
      );
    }
  }

  return parts.map((part) => `"${part}"`).join(".");
}

/**
 * Classifies PostgreSQL error codes into SyncError kinds:
 * - 23xxx (integrity constraint violations) -> permanent
 * - 22xxx (data exceptions, bad types/overflow) -> permanent
 * - 28xxx (auth failures) -> fatal
 * - 42xxx (syntax error, undefined table/column) -> fatal (schema mismatch / invalid config)
 * - 08xxx, 57xxx, 53xxx, network errors -> transient
 */
export function classifyPgError(err: unknown, context: string): SyncError {
  if (err instanceof SyncError) {
    return err;
  }

  const pgErr = err as { code?: string; message?: string };
  const code = pgErr.code ?? "";
  const msg = pgErr.message ?? String(err);

  // Auth / permission failures
  if (code.startsWith("28") || code === "42501") {
    return new SyncError("fatal", `PostgreSQL authentication/permission error in ${context}: ${msg}`, { cause: err });
  }

  // Schema mismatch / invalid object name
  if (code === "42P01" || code === "42703" || code.startsWith("42")) {
    return new SyncError("fatal", `PostgreSQL configuration/schema error in ${context}: ${msg}`, { cause: err });
  }

  // Data & constraint violations (record-specific failure)
  if (code.startsWith("23") || code.startsWith("22")) {
    return new SyncError("permanent", `PostgreSQL constraint/data error in ${context}: ${msg}`, { cause: err });
  }

  // Connection and availability errors
  if (
    code.startsWith("08") ||
    code.startsWith("57") ||
    code === "53300" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT"
  ) {
    return new SyncError("transient", `PostgreSQL connection error in ${context}: ${msg}`, { cause: err });
  }

  // Other unclassified errors are classified as transient once
  return new SyncError("transient", `PostgreSQL error in ${context}: ${msg}`, { cause: err });
}
