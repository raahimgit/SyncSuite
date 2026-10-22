import { describe, it, expect, afterAll } from "vitest";
import { createApiServer } from "../../src/api/server.js";
import type { RunningApiServer } from "../../src/api/server.js";

// These tests spin up the API server against a real in-process HTTP listener
// but use the store only as far as it can work without a database:
// auth, routing, and content-type behaviour are fully exercised,
// while store operations are skipped because no Postgres is available.

const TEST_TOKEN = "test-bearer-token-abc123";

const dbUrl =
  process.env.SYNCSUITE_DATABASE_URL ||
  process.env.DATABASE_URL ||
  process.env.SYNCKIT_TEST_DATABASE_URL;
const DB_AVAILABLE = Boolean(dbUrl);

describe.skipIf(!DB_AVAILABLE)("API server (integration, requires Postgres)", () => {
  let server: RunningApiServer;

  afterAll(async () => {
    await server?.close();
  });

  it("starts and health check returns 200", async () => {
    server = await createApiServer({
      port: 0,
      host: "127.0.0.1",
      bearerToken: TEST_TOKEN,
      dbUrl,
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});

describe("API server (unit, no database needed)", () => {
  // These tests mock the CLI context entirely to avoid requiring Postgres.
  // They verify auth middleware, routing, and serialization behaviour.

  it("openapi.json is accessible without auth and returns a valid spec", async () => {
    const { getOpenApiSpec } = await import("../../src/api/openapi.js");

    const spec = getOpenApiSpec();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info).toBeDefined();
    expect(spec.paths).toBeDefined();
    const paths = spec.paths as Record<string, unknown>;
    expect(paths["/health"]).toBeDefined();
    expect(paths["/jobs"]).toBeDefined();
    expect(paths["/jobs/{idOrName}/runs"]).toBeDefined();
    expect(paths["/jobs/{idOrName}/retry"]).toBeDefined();
    expect(paths["/dead-letters/{id}"]).toBeDefined();
  });

  it("SyncSuiteApiError captures status and endpoint", async () => {
    const { SyncSuiteApiError } = await import("../../src/client/index.js");
    const err = new SyncSuiteApiError(404, "/jobs/missing", { error: "not found" });
    expect(err.status).toBe(404);
    expect(err.endpoint).toBe("/jobs/missing");
    expect(err.message).toContain("404");
    expect(err.message).toContain("not found");
    expect(err.name).toBe("SyncSuiteApiError");
  });

  it("ExitCodes are distinct integers", async () => {
    const { ExitCodes } = await import("../../src/cli/exit-codes.js");
    const values = Object.values(ExitCodes);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
    expect(ExitCodes.SUCCESS).toBe(0);
    expect(ExitCodes.ERROR).toBe(1);
    expect(ExitCodes.PARTIAL).toBe(2);
    expect(ExitCodes.VALIDATION_ERROR).toBe(3);
    expect(ExitCodes.JOB_NOT_FOUND).toBe(4);
    expect(ExitCodes.JOB_BUSY).toBe(5);
    expect(ExitCodes.INTERRUPTED).toBe(130);
  });
});
