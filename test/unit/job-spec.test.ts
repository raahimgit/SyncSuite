import { describe, expect, it } from "vitest";
import { parseJobSpec, secretRefSchema } from "../../src/core/job-spec.js";

const minimal = {
  name: "users-to-crm",
  source: { type: "postgres" },
  destination: { type: "rest" },
};

describe("parseJobSpec", () => {
  it("applies documented defaults", () => {
    const spec = parseJobSpec(minimal);
    expect(spec.batchSize).toBe(500);
    expect(spec.concurrency).toBe(4);
    expect(spec.onRecordFailure).toBe("dead_letter");
    expect(spec.retry).toEqual({ maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 30_000, jitter: "full" });
    expect(spec.circuitBreaker.maxConsecutiveFailures).toBe(20);
    expect(spec.transform).toEqual([]);
    expect(spec.rateLimit).toBeUndefined();
  });

  it("rejects unknown top-level keys so typos are not silently ignored", () => {
    expect(() => parseJobSpec({ ...minimal, batchsize: 10 })).toThrow();
  });

  it("rejects names that are unsafe as identifiers", () => {
    for (const name of ["Users", "-users", "users to crm", "", "a".repeat(64)]) {
      expect(() => parseJobSpec({ ...minimal, name })).toThrow();
    }
  });

  it("rejects maxDelayMs below baseDelayMs", () => {
    expect(() => parseJobSpec({ ...minimal, retry: { baseDelayMs: 1000, maxDelayMs: 100 } })).toThrow(/maxDelayMs/);
  });

  it("rejects unknown transform operations", () => {
    expect(() => parseJobSpec({ ...minimal, transform: [{ op: "eval", code: "1+1" }] })).toThrow();
  });

  it("parses the first_name/last_name to full_name example", () => {
    const spec = parseJobSpec({
      ...minimal,
      transform: [
        { op: "concat", from: ["first_name", "last_name"], to: "full_name" },
        { op: "drop", fields: ["first_name", "last_name"] },
      ],
    });
    expect(spec.transform[0]).toEqual({ op: "concat", from: ["first_name", "last_name"], to: "full_name", separator: " " });
  });

  it("rejects non-positive rate limits", () => {
    expect(() => parseJobSpec({ ...minimal, rateLimit: { requestsPerSecond: 0 } })).toThrow();
  });

});

describe("secretRefSchema", () => {
  it("accepts conventional environment variable names", () => {
    expect(secretRefSchema.safeParse({ $env: "CRM_API_TOKEN" }).success).toBe(true);
  });

  it("rejects names that are not valid environment variable identifiers", () => {
    for (const name of ["not valid", "lower_case", "1STARTS_WITH_DIGIT", ""]) {
      expect(secretRefSchema.safeParse({ $env: name }).success).toBe(false);
    }
  });

  it("rejects extra keys so a literal value cannot ride along", () => {
    expect(secretRefSchema.safeParse({ $env: "TOKEN", value: "hunter2" }).success).toBe(false);
  });
});
