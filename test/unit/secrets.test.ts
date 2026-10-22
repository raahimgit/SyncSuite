import { describe, expect, it } from "vitest";
import { isSecretRef, resolveSecret, resolveSecretsDeep } from "../../src/connectors/secrets.js";
import { SyncError } from "../../src/core/types.js";

describe("secrets helper", () => {
  it("resolves plain string literals", () => {
    expect(resolveSecret("my-secret-value")).toBe("my-secret-value");
  });

  it("detects SecretRef objects", () => {
    expect(isSecretRef({ $env: "DATABASE_URL" })).toBe(true);
    expect(isSecretRef({ $env: 123 })).toBe(false);
    expect(isSecretRef("DATABASE_URL")).toBe(false);
    expect(isSecretRef(null)).toBe(false);
  });

  it("resolves existing environment variables", () => {
    process.env.TEST_SYNCKIT_KEY = "super-secret-123";
    try {
      expect(resolveSecret({ $env: "TEST_SYNCKIT_KEY" })).toBe("super-secret-123");
    } finally {
      delete process.env.TEST_SYNCKIT_KEY;
    }
  });

  it("throws fatal SyncError for missing environment variable without printing value", () => {
    delete process.env.DEFINITELY_NONEXISTENT_VAR;
    expect(() => resolveSecret({ $env: "DEFINITELY_NONEXISTENT_VAR" }, "api key")).toThrowError(
      SyncError,
    );
    try {
      resolveSecret({ $env: "DEFINITELY_NONEXISTENT_VAR" }, "api key");
    } catch (err) {
      const syncErr = err as SyncError;
      expect(syncErr.kind).toBe("fatal");
      expect(syncErr.message).toContain("missing required environment variable: DEFINITELY_NONEXISTENT_VAR");
    }
  });

  it("throws fatal SyncError for invalid configuration type", () => {
    expect(() => resolveSecret(12345, "param")).toThrowError(SyncError);
  });

  it("resolves secrets recursively in nested configuration objects", () => {
    process.env.TEST_PG_PASS = "pgpass123";
    try {
      const config = {
        host: "localhost",
        port: 5432,
        auth: {
          username: "admin",
          password: { $env: "TEST_PG_PASS" },
        },
        tags: ["a", { $env: "TEST_PG_PASS" }],
      };

      const resolved = resolveSecretsDeep(config);
      expect(resolved.auth.password).toBe("pgpass123");
      expect(resolved.tags[1]).toBe("pgpass123");
      expect(resolved.host).toBe("localhost");
      expect(resolved.port).toBe(5432);
    } finally {
      delete process.env.TEST_PG_PASS;
    }
  });
});
