import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RestDestination } from "../../src/connectors/rest-destination.js";
import { RestSource } from "../../src/connectors/rest-source.js";
import { SyncError } from "../../src/core/types.js";

describe("REST connectors (in-process HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;
  const receivedRequests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];

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

        // Route: /api/destination
        if (url.pathname.startsWith("/api/destination")) {
          if (url.pathname.endsWith("/not-modified")) {
            res.statusCode = 304;
            return res.end();
          }
          if (url.pathname.endsWith("/rate-limited")) {
            res.statusCode = 429;
            res.setHeader("Retry-After", "45");
            return res.end(JSON.stringify({ error: "too many requests" }));
          }
          if (url.pathname.endsWith("/unauthorized")) {
            res.statusCode = 401;
            return res.end(JSON.stringify({ error: "invalid token" }));
          }
          if (url.pathname.endsWith("/validation-error")) {
            res.statusCode = 422;
            return res.end(JSON.stringify({ error: "invalid email format" }));
          }

          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({ success: true }));
        }

        // Route: /api/source/cursor
        if (url.pathname === "/api/source/cursor") {
          const cursor = url.searchParams.get("cursor");
          if (cursor === "expired_token") {
            res.statusCode = 404;
            return res.end(JSON.stringify({ error: "page not found" }));
          }

          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          if (!cursor) {
            return res.end(
              JSON.stringify({
                data: [
                  { id: "rec-1", name: "Alice" },
                  { id: "rec-2", name: "Bob" },
                ],
                next_cursor: "cur_page_2",
              }),
            );
          }
          return res.end(
            JSON.stringify({
              data: [{ id: "rec-3", name: "Charlie" }],
              next_cursor: null,
            }),
          );
        }

        // Route: /api/source/offset
        if (url.pathname === "/api/source/offset") {
          const offset = Number(url.searchParams.get("offset") ?? "0");
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          if (offset === 0) {
            return res.end(
              JSON.stringify({
                items: [
                  { key: "item-1", val: 10 },
                  { key: "item-2", val: 20 },
                ],
              }),
            );
          }
          return res.end(JSON.stringify({ items: [] }));
        }

        // Route: /api/source/link
        if (url.pathname === "/api/source/link") {
          const page = url.searchParams.get("page");
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          if (!page) {
            res.setHeader("Link", `<${baseUrl}/api/source/link?page=2>; rel="next"`);
            return res.end(JSON.stringify({ records: [{ id: "l1" }, { id: "l2" }] }));
          }
          return res.end(JSON.stringify({ records: [{ id: "l3" }] }));
        }

        res.statusCode = 404;
        res.end("Not Found");
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe("RestDestination", () => {
    it("writes record with idempotency key and auth headers", async () => {
      const dest = new RestDestination({
        url: `${baseUrl}/api/destination`,
        method: "POST",
        idempotencyHeader: "X-Idempotency-Key",
        auth: { type: "bearer", token: "test-token" },
        headers: { "X-Custom": "header-value" },
        allowPrivateNetworks: true,
        allowHttp: true,
      });

      const controller = new AbortController();
      await dest.open(controller.signal);

      const res = await dest.write(
        {
          key: "user-1",
          idempotencyKey: "idem-key-abc",
          data: { name: "Alice", email: "alice@example.com" },
        },
        controller.signal,
      );

      expect(res.status).toBe("written");
      const lastReq = receivedRequests[receivedRequests.length - 1]!;
      expect(lastReq.headers["x-idempotency-key"]).toBe("idem-key-abc");
      expect(lastReq.headers["authorization"]).toBe("Bearer test-token");
      expect(lastReq.headers["x-custom"]).toBe("header-value");
      expect(JSON.parse(lastReq.body)).toEqual({ name: "Alice", email: "alice@example.com" });
    });

    it("handles 304 response as unchanged", async () => {
      const dest = new RestDestination({
        url: `${baseUrl}/api/destination/not-modified`,
        allowPrivateNetworks: true,
        allowHttp: true,
      });

      const controller = new AbortController();
      const res = await dest.write(
        { key: "u1", idempotencyKey: "k1", data: {} },
        controller.signal,
      );
      expect(res.status).toBe("unchanged");
    });

    it("handles keyDerivedUrl by appending key to URL", async () => {
      const dest = new RestDestination({
        url: `${baseUrl}/api/destination`,
        keyDerivedUrl: true,
        allowPrivateNetworks: true,
        allowHttp: true,
      });

      const controller = new AbortController();
      await dest.write(
        { key: "user-99", idempotencyKey: "k2", data: { foo: "bar" } },
        controller.signal,
      );

      const lastReq = receivedRequests[receivedRequests.length - 1]!;
      expect(lastReq.method).toBe("PUT");
      expect(lastReq.url).toBe("/api/destination/user-99");
    });


    it("maps 429 response to rate_limited with retryAfterMs", async () => {
      const dest = new RestDestination({
        url: `${baseUrl}/api/destination/rate-limited`,
        allowPrivateNetworks: true,
        allowHttp: true,
      });

      const controller = new AbortController();
      await expect(
        dest.write({ key: "u1", idempotencyKey: "k1", data: {} }, controller.signal),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(SyncError);
        const syncErr = err as SyncError;
        expect(syncErr.kind).toBe("rate_limited");
        expect(syncErr.retryAfterMs).toBe(45_000);
        return true;
      });
    });

    it("maps 401 response to fatal SyncError", async () => {
      const dest = new RestDestination({
        url: `${baseUrl}/api/destination/unauthorized`,
        allowPrivateNetworks: true,
        allowHttp: true,
      });

      const controller = new AbortController();
      await expect(
        dest.write({ key: "u1", idempotencyKey: "k1", data: {} }, controller.signal),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(SyncError);
        expect((err as SyncError).kind).toBe("fatal");
        return true;
      });
    });

    it("maps 422 validation response to permanent SyncError", async () => {
      const dest = new RestDestination({
        url: `${baseUrl}/api/destination/validation-error`,
        allowPrivateNetworks: true,
        allowHttp: true,
      });

      const controller = new AbortController();
      await expect(
        dest.write({ key: "u1", idempotencyKey: "k1", data: {} }, controller.signal),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(SyncError);
        expect((err as SyncError).kind).toBe("permanent");
        return true;
      });
    });

    it("plan() returns non-empty description without throwing", async () => {
      const dest = new RestDestination({
        url: `${baseUrl}/api/destination`,
        allowPrivateNetworks: true,
        allowHttp: true,
      });

      const plan = await dest.plan(
        { key: "u1", idempotencyKey: "idem-1", data: { a: 1 } },
        new AbortController().signal,
      );
      expect(plan.action).toBe("unknown");
      expect(plan.description).toContain("Idempotency-Key");
    });
  });

  describe("RestSource", () => {
    it("reads batch with cursor pagination", async () => {
      const source = new RestSource({
        url: `${baseUrl}/api/source/cursor`,
        recordsPath: "data",
        keyField: "id",
        pagination: {
          type: "cursor",
          cursorParam: "cursor",
          cursorResponsePath: "next_cursor",
        },
        allowPrivateNetworks: true,
        allowHttp: true,
      });

      const controller = new AbortController();
      await source.open(controller.signal);

      // Batch 1 (from null)
      const batch1 = await source.readBatch(null, 2, controller.signal);
      expect(batch1.records).toHaveLength(2);
      expect(batch1.records[0]!.key).toBe("rec-1");
      expect(batch1.nextCursor).toEqual({ cursor: "cur_page_2" });

      // Batch 2 (from batch1.nextCursor)
      const batch2 = await source.readBatch(batch1.nextCursor, 2, controller.signal);
      expect(batch2.records).toHaveLength(1);
      expect(batch2.records[0]!.key).toBe("rec-3");
      expect(batch2.nextCursor).toBeNull();
    });

    it("reads batch with offset pagination", async () => {
      const source = new RestSource({
        url: `${baseUrl}/api/source/offset`,
        recordsPath: "items",
        keyField: "key",
        pagination: {
          type: "offset",
          offsetParam: "offset",
        },
        allowPrivateNetworks: true,
        allowHttp: true,
      });

      const controller = new AbortController();
      const batch1 = await source.readBatch(null, 2, controller.signal);
      expect(batch1.records).toHaveLength(2);
      expect(batch1.records[0]!.key).toBe("item-1");
      expect(batch1.nextCursor).toEqual({ offset: 2 });

      const batch2 = await source.readBatch(batch1.nextCursor, 2, controller.signal);
      expect(batch2.records).toHaveLength(0);
      expect(batch2.nextCursor).toBeNull();
    });

    it("reads batch with Link header pagination", async () => {
      const source = new RestSource({
        url: `${baseUrl}/api/source/link`,
        recordsPath: "records",
        keyField: "id",
        pagination: { type: "link" },
        allowPrivateNetworks: true,
        allowHttp: true,
      });

      const controller = new AbortController();
      const batch1 = await source.readBatch(null, 2, controller.signal);
      expect(batch1.records).toHaveLength(2);
      expect(batch1.nextCursor).toEqual({ nextUrl: `${baseUrl}/api/source/link?page=2` });

      const batch2 = await source.readBatch(batch1.nextCursor, 2, controller.signal);
      expect(batch2.records).toHaveLength(1);
      expect(batch2.nextCursor).toBeNull();
    });


    it("classifies 404 on paginated cursor as fatal expired token", async () => {
      const source = new RestSource({
        url: `${baseUrl}/api/source/cursor`,
        recordsPath: "data",
        keyField: "id",
        pagination: { type: "cursor" },
        allowPrivateNetworks: true,
        allowHttp: true,
      });

      const controller = new AbortController();
      await expect(
        source.readBatch({ cursor: "expired_token" }, 2, controller.signal),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(SyncError);
        const syncErr = err as SyncError;
        expect(syncErr.kind).toBe("fatal");
        expect(syncErr.message).toContain("pagination token expired");
        return true;
      });
    });
  });
});
