import { SyncError } from "../core/types.js";
import type { SecretRef } from "../core/job-spec.js";

export function isSecretRef(val: unknown): val is SecretRef {
  return (
    typeof val === "object" &&
    val !== null &&
    "$env" in val &&
    typeof (val as Record<string, unknown>).$env === "string"
  );
}

/**
 * Resolves a string or { $env: "NAME" } secret reference from the environment.
 * Throws a fatal SyncError if the environment variable is missing or empty.
 * Never logs or prints the secret value.
 */
export function resolveSecret(val: unknown, fieldName = "secret"): string {
  if (typeof val === "string") {
    return val;
  }
  if (isSecretRef(val)) {
    const envVar = val.$env;
    const resolved = process.env[envVar];
    if (resolved === undefined || resolved === "") {
      throw new SyncError("fatal", `missing required environment variable: ${envVar} for ${fieldName}`);
    }
    return resolved;
  }
  throw new SyncError("fatal", `invalid configuration for ${fieldName}: expected string or { $env: "NAME" }`);
}

/**
 * Recursively resolves all { $env: "..." } objects in a configuration tree.
 * Plain strings and other primitives are preserved as-is.
 */
export function resolveSecretsDeep<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (isSecretRef(value)) {
    return resolveSecret(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveSecretsDeep(item)) as unknown as T;
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveSecretsDeep(v);
    }
    return result as unknown as T;
  }
  return value;
}
