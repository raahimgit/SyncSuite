import { describe, expect, it } from "vitest";
import { formatDatabaseError } from "../../src/cli/config.js";
import { parseConnectionString } from "../../src/db/pool.js";

describe("formatDatabaseError", () => {
  it("diagnoses Supabase pooler missing project-ref in username (code 28P01)", () => {
    const err = Object.assign(new Error('password authentication failed for user "postgres"'), {
      code: "28P01",
    });
    const url = "postgresql://postgres:secret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres";
    const formatted = formatDatabaseError(err, url);

    expect(formatted).toContain("Supabase Connection Pooler detected");
    expect(formatted).toContain("postgres.[project-ref]");
    expect(formatted).toContain("Current username in URL: \"postgres\"");
    expect(formatted).toContain("FIX: Update your DATABASE_URL");
  });

  it("handles general password failure for standard databases (code 28P01)", () => {
    const err = Object.assign(new Error('password authentication failed for user "myuser"'), {
      code: "28P01",
    });
    const url = "postgresql://myuser:secret@localhost:5432/mydb";
    const formatted = formatDatabaseError(err, url);

    expect(formatted).toContain("The database rejected the password for user 'myuser'");
    expect(formatted).toContain("Verify the database password");
  });

  it("diagnoses ENOTFOUND host errors", () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND invalid-host"), {
      code: "ENOTFOUND",
    });
    const url = "postgresql://user:pass@invalid-host:5432/db";
    const formatted = formatDatabaseError(err, url);

    expect(formatted).toContain("Could not resolve hostname 'invalid-host'");
  });

  it("diagnoses ECONNREFUSED port errors", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5433"), {
      code: "ECONNREFUSED",
    });
    const url = "postgresql://user:pass@127.0.0.1:5433/db";
    const formatted = formatDatabaseError(err, url);

    expect(formatted).toContain("Connection refused at 127.0.0.1:5433");
  });

  it("diagnoses ETIMEDOUT network errors", () => {
    const err = Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:5432"), {
      code: "ETIMEDOUT",
    });
    const url = "postgresql://user:pass@10.0.0.1:5432/db";
    const formatted = formatDatabaseError(err, url);

    expect(formatted).toContain("Connection to 10.0.0.1:5432 timed out");
  });
});

describe("parseConnectionString", () => {
  it("handles unencoded '@' character inside the password", () => {
    const raw = "postgresql://postgres.vetsuipmzqoewidwozkz:syncsuite@386@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres";
    const config = parseConnectionString(raw);

    expect(config.user).toBe("postgres.vetsuipmzqoewidwozkz");
    expect(config.password).toBe("syncsuite@386");
    expect(config.host).toBe("aws-0-ap-northeast-1.pooler.supabase.com");
    expect(config.port).toBe(6543);
    expect(config.database).toBe("postgres");
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("handles unencoded '#' character inside the password", () => {
    const raw = "postgresql://myuser:p#ss#123@localhost:5432/mydb";
    const config = parseConnectionString(raw);

    expect(config.user).toBe("myuser");
    expect(config.password).toBe("p#ss#123");
    expect(config.host).toBe("localhost");
    expect(config.port).toBe(5432);
    expect(config.database).toBe("mydb");
    expect(config.ssl).toBeUndefined();
  });

  it("handles unencoded ':' character inside the password", () => {
    const raw = "postgresql://myuser:pass:with:colons@db.example.com:5432/mydb";
    const config = parseConnectionString(raw);

    expect(config.user).toBe("myuser");
    expect(config.password).toBe("pass:with:colons");
    expect(config.host).toBe("db.example.com");
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("auto-heals accidentally encoded host delimiter (%40 instead of @ before host)", () => {
    const raw = "postgresql://postgres.vetsuipmzqoewidwozkz:syncsuite%40386%40aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres";
    const config = parseConnectionString(raw);

    expect(config.user).toBe("postgres.vetsuipmzqoewidwozkz");
    expect(config.password).toBe("syncsuite@386");
    expect(config.host).toBe("aws-0-ap-northeast-1.pooler.supabase.com");
    expect(config.port).toBe(6543);
    expect(config.database).toBe("postgres");
  });

  it("handles encoded characters seamlessly without double-encoding", () => {
    const raw = "postgresql://user:pass%40word@localhost:5432/db";
    const config = parseConnectionString(raw);

    expect(config.user).toBe("user");
    expect(config.password).toBe("pass@word");
  });

  it("handles simple URL without credentials", () => {
    const raw = "postgresql://localhost:5432/testdb";
    const config = parseConnectionString(raw);

    expect(config.host).toBe("localhost");
    expect(config.port).toBe(5432);
    expect(config.database).toBe("testdb");
    expect(config.user).toBeUndefined();
    expect(config.password).toBeUndefined();
  });
});
