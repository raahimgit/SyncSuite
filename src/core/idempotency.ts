import { createHash } from "node:crypto";

// Produces a stable string for equal data regardless of key order, so the
// content hash does not change when a source returns columns in a different
// order. Values JSON cannot represent faithfully get explicit encodings;
// otherwise NaN and null, or 1n and "1", would hash identically.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : { $number: String(value) };
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? { $invalidDate: true } : value.toISOString();
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = canonicalize((value as Record<string, unknown>)[key]);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  throw new TypeError(`cannot canonicalize value of type ${typeof value}`);
}

export function contentHash(data: unknown): string {
  return createHash("sha256").update(canonicalJson(data)).digest("hex");
}

// Hashes a JSON array rather than a delimiter-joined string: a record key
// containing the delimiter could otherwise collide with a different
// (recordKey, contentHash) pair.
export function idempotencyKey(jobId: string, recordKey: string, hash: string): string {
  return createHash("sha256").update(JSON.stringify([jobId, recordKey, hash])).digest("hex");
}
