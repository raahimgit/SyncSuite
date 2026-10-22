import { describe, it, expect } from "vitest";
import { createJsonLogger, RedactionFilter } from "../../src/core/logger.js";

describe("RedactionFilter", () => {
  it("redacts sensitive keys regardless of case", () => {
    const filter = new RedactionFilter();
    const result = filter.redactValue({
      username: "alice",
      password: "super-secret-password",
      api_key: "abc123xyz",
      TOKEN: "bearer-token-val",
      deep: {
        authorization: "Bearer 123456",
      },
    }) as Record<string, unknown>;

    expect(result.username).toBe("alice");
    expect(result.password).toBe("[REDACTED]");
    expect(result.api_key).toBe("[REDACTED]");
    expect(result.TOKEN).toBe("[REDACTED]");
    const deep = result.deep as Record<string, unknown>;
    expect(deep.authorization).toBe("[REDACTED]");
  });

  it("does not redact safe keys like keyColumn or cursorColumn", () => {
    const filter = new RedactionFilter();
    const result = filter.redactValue({
      keyColumn: "id",
      cursorColumn: "updated_at",
      keyDerivedUrl: true,
      idempotencyKeyHeader: "Idempotency-Key",
    }) as Record<string, unknown>;

    expect(result.keyColumn).toBe("id");
    expect(result.cursorColumn).toBe("updated_at");
    expect(result.keyDerivedUrl).toBe(true);
    expect(result.idempotencyKeyHeader).toBe("Idempotency-Key");
  });

  it("redacts credentials embedded in URLs", () => {
    const filter = new RedactionFilter();
    const url = "postgres://admin:topsecret123@db.prod.internal:5432/analytics";
    const redacted = filter.redactString(url);

    expect(redacted).toBe("postgres://admin:[REDACTED]@db.prod.internal:5432/analytics");
    expect(redacted).not.toContain("topsecret123");
  });

  it("redacts dynamically registered secret strings", () => {
    const filter = new RedactionFilter([], ["my-dynamic-secret-42"]);
    const message = "Request failed for client with token my-dynamic-secret-42 in url";
    const redacted = filter.redactString(message);

    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("my-dynamic-secret-42");
  });

  it("redacts errors and error stacks", () => {
    const filter = new RedactionFilter();
    const err = new Error("Failed connecting to postgres://user:secretpw@localhost/db");
    const result = filter.redactError(err);

    expect(result.message).toContain("[REDACTED]");
    expect(result.message).not.toContain("secretpw");
  });
});

describe("JsonLogger", () => {
  it("outputs structured JSON logs with event and level", () => {
    const lines: string[] = [];
    const logger = createJsonLogger({
      level: "debug",
      writer: (line) => lines.push(line),
      clock: () => new Date("2026-10-06T12:00:00Z"),
    });

    logger.info("job.started", { jobId: "job-1", records: 100 });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.level).toBe("info");
    expect(parsed.event).toBe("job.started");
    expect(parsed.jobId).toBe("job-1");
    expect(parsed.records).toBe(100);
    expect(parsed.timestamp).toBe("2026-10-06T12:00:00.000Z");
  });

  it("respects log level filtering", () => {
    const lines: string[] = [];
    const logger = createJsonLogger({
      level: "warn",
      writer: (line) => lines.push(line),
    });

    logger.debug("debug.event");
    logger.info("info.event");
    logger.warn("warn.event");
    logger.error("error.event");

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).level).toBe("warn");
    expect(JSON.parse(lines[1]!).level).toBe("error");
  });

  it("automatically redacts sensitive fields in logged payloads", () => {
    const lines: string[] = [];
    const logger = createJsonLogger({
      writer: (line) => lines.push(line),
    });

    logger.info("auth.completed", {
      userId: "u-123",
      password: "plain-password",
      connectionUrl: "mysql://root:secret@10.0.0.1/db",
    });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.userId).toBe("u-123");
    expect(parsed.password).toBe("[REDACTED]");
    expect(parsed.connectionUrl).toContain("[REDACTED]");
    expect(lines[0]).not.toContain("plain-password");
  });

  it("child logger inherits context and shares redaction filter", () => {
    const lines: string[] = [];
    const parent = createJsonLogger({
      writer: (line) => lines.push(line),
      context: { service: "syncsuite-worker" },
    });

    const child = parent.child({ runId: "run-abc" });
    child.info("batch.completed", { count: 50 });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.service).toBe("syncsuite-worker");
    expect(parsed.runId).toBe("run-abc");
    expect(parsed.count).toBe(50);
  });
});
