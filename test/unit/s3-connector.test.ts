import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3Destination, signAwsV4 } from "../../src/connectors/s3-destination.js";
import { createDefaultRegistry } from "../../src/connectors/index.js";
import { SyncError } from "../../src/core/types.js";

describe("S3 Destination Connector", () => {
  let server: http.Server;
  let endpoint: string;
  const receivedRequests: Array<{
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        receivedRequests.push({
          method: req.method ?? "GET",
          url: req.url ?? "/",
          headers: req.headers,
          body,
        });

        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

        // Error mock routes
        if (url.pathname.includes("/unauthorized")) {
          res.statusCode = 403;
          return res.end("<Error><Code>AccessDenied</Code></Error>");
        }
        if (url.pathname.includes("/rate-limited")) {
          res.statusCode = 429;
          res.setHeader("Retry-After", "30");
          return res.end("<Error><Code>SlowDown</Code></Error>");
        }
        if (url.pathname.includes("/server-error")) {
          res.statusCode = 500;
          return res.end("<Error><Code>InternalError</Code></Error>");
        }

        // HEAD routes for plan()
        if (req.method === "HEAD") {
          if (url.pathname.includes("existing-key")) {
            res.statusCode = 200;
            return res.end();
          }
          res.statusCode = 404;
          return res.end();
        }

        // Default PUT response
        res.statusCode = 200;
        res.setHeader("ETag", '"mock-etag-12345"');
        res.end();
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe("Configuration & Validation", () => {
    it("throws fatal SyncError if required fields are missing", () => {
      expect(() => new S3Destination({} as Record<string, unknown>)).toThrowError(
        /missing required string 'bucket'/,
      );
      expect(() => new S3Destination({ bucket: "my-bucket" })).toThrowError(
        /missing required 'accessKeyId'/,
      );
      expect(() => new S3Destination({ bucket: "my-bucket", accessKeyId: "key" })).toThrowError(
        /missing required 'secretAccessKey'/,
      );
    });

    it("registers into default ConnectorRegistry under 's3'", () => {
      const registry = createDefaultRegistry();
      const dest = registry.createDestination("s3", {
        bucket: "test-bucket",
        accessKeyId: "akid",
        secretAccessKey: "secret",
      });
      expect(dest.type).toBe("s3");
    });
  });

  describe("AWS SigV4 Signing", () => {
    it("generates valid AWS4-HMAC-SHA256 headers", () => {
      const headers = signAwsV4({
        method: "PUT",
        url: new URL("https://my-bucket.s3.us-east-1.amazonaws.com/orders/ord-1.json"),
        body: '{"id":"ord-1"}',
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        region: "us-east-1",
        date: new Date("2026-10-14T12:00:00Z"),
      });

      expect(headers["x-amz-date"]).toBe("20261014T120000Z");
      expect(headers["x-amz-content-sha256"]).toBeDefined();
      expect(headers["Authorization"]).toContain("AWS4-HMAC-SHA256");
      expect(headers["Authorization"]).toContain("Credential=AKIAIOSFODNN7EXAMPLE/20261014/us-east-1/s3/aws4_request");
      expect(headers["Authorization"]).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
      expect(headers["Authorization"]).toMatch(/Signature=[a-f0-9]{64}/);
    });

    it("includes session token when provided", () => {
      const headers = signAwsV4({
        method: "PUT",
        url: new URL("https://my-bucket.s3.us-east-1.amazonaws.com/test.json"),
        body: "{}",
        accessKeyId: "ASIAEXAMPLE",
        secretAccessKey: "secret",
        sessionToken: "session-token-123",
        region: "us-east-1",
      });

      expect(headers["x-amz-security-token"]).toBe("session-token-123");
      expect(headers["Authorization"]).toContain("x-amz-security-token");
    });
  });

  describe("Live S3 Operations (via HTTP mock)", () => {
    it("writes record to S3-compatible endpoint with JSON format", async () => {
      receivedRequests.length = 0;
      const dest = new S3Destination({
        bucket: "analytics",
        endpoint,
        prefix: "records/orders",
        accessKeyId: "my-key",
        secretAccessKey: "my-secret",
        allowPrivateNetworks: true,
      });

      const controller = new AbortController();
      await dest.open(controller.signal);

      const writeRes = await dest.write(
        {
          key: "ord-100",
          idempotencyKey: "idem-1",
          data: { id: "ord-100", amount: 4999, status: "paid" },
        },
        controller.signal,
      );

      expect(writeRes.status).toBe("written");
      expect(receivedRequests.length).toBe(1);

      const req = receivedRequests[0]!;
      expect(req.method).toBe("PUT");
      expect(req.url).toBe("/analytics/records/orders/ord-100.json");
      expect(req.headers["content-type"]).toBe("application/json");
      expect(req.headers["authorization"]).toContain("AWS4-HMAC-SHA256");

      const parsedBody = JSON.parse(req.body);
      expect(parsedBody).toEqual({ id: "ord-100", amount: 4999, status: "paid" });
    });

    it("writes record with NDJSON format when configured", async () => {
      receivedRequests.length = 0;
      const dest = new S3Destination({
        bucket: "analytics",
        endpoint,
        prefix: "ndjson",
        format: "ndjson",
        accessKeyId: "my-key",
        secretAccessKey: "my-secret",
        allowPrivateNetworks: true,
      });

      const controller = new AbortController();
      await dest.open(controller.signal);

      await dest.write(
        {
          key: "rec-1",
          idempotencyKey: "idem-2",
          data: { key: "rec-1", val: "sample" },
        },
        controller.signal,
      );

      const req = receivedRequests[0]!;
      expect(req.url).toBe("/analytics/ndjson/rec-1.ndjson");
      expect(req.headers["content-type"]).toBe("application/x-ndjson");
      expect(req.body).toBe('{"key":"rec-1","val":"sample"}\n');
    });

    it("plans write: detects create vs update via HEAD request", async () => {
      const dest = new S3Destination({
        bucket: "analytics",
        endpoint,
        accessKeyId: "key",
        secretAccessKey: "secret",
        allowPrivateNetworks: true,
      });

      const controller = new AbortController();
      await dest.open(controller.signal);

      // Existing object
      const planExisting = await dest.plan(
        { key: "existing-key", idempotencyKey: "i1", data: {} },
        controller.signal,
      );
      expect(planExisting.action).toBe("update");
      expect(planExisting.description).toContain("exists and will be overwritten");

      // Non-existing object
      const planNew = await dest.plan(
        { key: "new-key", idempotencyKey: "i2", data: {} },
        controller.signal,
      );
      expect(planNew.action).toBe("create");
      expect(planNew.description).toContain("does not exist and will be created");
    });

    it("handles S3 authentication errors as fatal", async () => {
      const dest = new S3Destination({
        bucket: "analytics",
        endpoint,
        prefix: "unauthorized",
        accessKeyId: "key",
        secretAccessKey: "secret",
        allowPrivateNetworks: true,
      });

      const controller = new AbortController();
      await dest.open(controller.signal);

      await expect(
        dest.write({ key: "k", idempotencyKey: "i", data: {} }, controller.signal),
      ).rejects.toThrowError(SyncError);

      try {
        await dest.write({ key: "k", idempotencyKey: "i", data: {} }, controller.signal);
      } catch (err) {
        expect(err instanceof SyncError).toBe(true);
        expect((err as SyncError).kind).toBe("fatal");
      }
    });

    it("handles S3 rate limiting as rate_limited error", async () => {
      const dest = new S3Destination({
        bucket: "analytics",
        endpoint,
        prefix: "rate-limited",
        accessKeyId: "key",
        secretAccessKey: "secret",
        allowPrivateNetworks: true,
      });

      const controller = new AbortController();
      await dest.open(controller.signal);

      try {
        await dest.write({ key: "k", idempotencyKey: "i", data: {} }, controller.signal);
      } catch (err) {
        expect(err instanceof SyncError).toBe(true);
        expect((err as SyncError).kind).toBe("rate_limited");
        expect((err as SyncError).retryAfterMs).toBe(30_000);
      }
    });

    it("resolves $env secrets dynamically", async () => {
      process.env.TEST_S3_KEY = "env-access-key";
      process.env.TEST_S3_SECRET = "env-secret-key";

      const dest = new S3Destination({
        bucket: "analytics",
        endpoint,
        accessKeyId: { $env: "TEST_S3_KEY" },
        secretAccessKey: { $env: "TEST_S3_SECRET" },
        allowPrivateNetworks: true,
      });

      const controller = new AbortController();
      await dest.open(controller.signal);

      const res = await dest.write({ key: "env-test", idempotencyKey: "i", data: { a: 1 } }, controller.signal);
      expect(res.status).toBe("written");

      delete process.env.TEST_S3_KEY;
      delete process.env.TEST_S3_SECRET;
    });
  });
});
