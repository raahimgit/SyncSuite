import { describe, expect, it } from "vitest";
import {
  buildAuthHeaders,
  classifyHttpStatus,
  parseRetryAfter,
} from "../../src/connectors/http-utils.js";

describe("http-utils", () => {
  describe("buildAuthHeaders", () => {
    it("returns empty object when no auth is configured", () => {
      expect(buildAuthHeaders(undefined)).toEqual({});
    });

    it("builds bearer token header", () => {
      const headers = buildAuthHeaders({ type: "bearer", token: "tok123" });
      expect(headers).toEqual({ Authorization: "Bearer tok123" });
    });

    it("builds basic auth header with base64 encoding", () => {
      const headers = buildAuthHeaders({ type: "basic", username: "user", password: "pwd" });
      const expected = `Basic ${Buffer.from("user:pwd").toString("base64")}`;
      expect(headers).toEqual({ Authorization: expected });
    });

    it("builds custom apiKey header", () => {
      const headers = buildAuthHeaders({ type: "apiKey", header: "X-API-Key", key: "secret-key-1" });
      expect(headers).toEqual({ "X-API-Key": "secret-key-1" });
    });
  });

  describe("parseRetryAfter", () => {
    it("parses integer seconds into milliseconds", () => {
      expect(parseRetryAfter("30")).toBe(30_000);
      expect(parseRetryAfter("0")).toBe(0);
      expect(parseRetryAfter("120")).toBe(120_000);
    });

    it("parses HTTP-date string", () => {
      const future = new Date(Date.now() + 15_000).toUTCString();
      const parsed = parseRetryAfter(future);
      expect(parsed).toBeDefined();
      expect(parsed!).toBeGreaterThanOrEqual(14_000);
      expect(parsed!).toBeLessThanOrEqual(16_000);
    });

    it("returns undefined for missing or invalid header", () => {
      expect(parseRetryAfter(undefined)).toBeUndefined();
      expect(parseRetryAfter("")).toBeUndefined();
      expect(parseRetryAfter("not-a-number-or-date")).toBeUndefined();
    });
  });

  describe("classifyHttpStatus", () => {
    it("classifies 401 and 403 as fatal", () => {
      expect(classifyHttpStatus(401, "Unauthorized", "bad token").kind).toBe("fatal");
      expect(classifyHttpStatus(403, "Forbidden", "forbidden").kind).toBe("fatal");
    });

    it("classifies 429 as rate_limited with parsed retryAfterMs", () => {
      const err = classifyHttpStatus(429, "Too Many Requests", "slow down", "60");
      expect(err.kind).toBe("rate_limited");
      expect(err.retryAfterMs).toBe(60_000);
    });

    it("classifies 400 and 422 as permanent", () => {
      expect(classifyHttpStatus(400, "Bad Request", "invalid payload").kind).toBe("permanent");
      expect(classifyHttpStatus(422, "Unprocessable Entity", "validation error").kind).toBe("permanent");
    });

    it("classifies 5xx and 408 as transient", () => {
      expect(classifyHttpStatus(408, "Request Timeout", "timeout").kind).toBe("transient");
      expect(classifyHttpStatus(500, "Internal Server Error", "error").kind).toBe("transient");
      expect(classifyHttpStatus(502, "Bad Gateway", "gateway").kind).toBe("transient");
      expect(classifyHttpStatus(503, "Service Unavailable", "busy").kind).toBe("transient");
      expect(classifyHttpStatus(504, "Gateway Timeout", "timeout").kind).toBe("transient");
    });
  });
});
