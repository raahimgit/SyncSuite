import { describe, expect, it } from "vitest";
import { classifyPgError, quoteIdentifier } from "../../src/connectors/sql-utils.js";
import { SyncError } from "../../src/core/types.js";

describe("sql-utils", () => {
  describe("quoteIdentifier", () => {
    it("quotes single valid identifiers", () => {
      expect(quoteIdentifier("users")).toBe('"users"');
      expect(quoteIdentifier("created_at")).toBe('"created_at"');
      expect(quoteIdentifier("_id")).toBe('"_id"');
    });

    it("quotes schema-qualified identifiers", () => {
      expect(quoteIdentifier("public.users")).toBe('"public"."users"');
      expect(quoteIdentifier("analytics.events")).toBe('"analytics"."events"');
    });

    it("rejects invalid characters and injection attempts", () => {
      expect(() => quoteIdentifier("users; DROP TABLE users;--")).toThrowError(SyncError);
      expect(() => quoteIdentifier("users 123")).toThrowError(SyncError);
      expect(() => quoteIdentifier("users-table")).toThrowError(SyncError);
      expect(() => quoteIdentifier("")).toThrowError(SyncError);
    });
  });

  describe("classifyPgError", () => {
    it("classifies authentication/permission errors as fatal", () => {
      const err = { code: "28P01", message: "password authentication failed" };
      const classified = classifyPgError(err, "test");
      expect(classified.kind).toBe("fatal");
    });

    it("classifies undefined table/column as fatal (config mismatch)", () => {
      const err = { code: "42P01", message: "relation does not exist" };
      const classified = classifyPgError(err, "test");
      expect(classified.kind).toBe("fatal");
    });

    it("classifies integrity constraint violations as permanent", () => {
      const uniqueErr = { code: "23505", message: "duplicate key value violates unique constraint" };
      expect(classifyPgError(uniqueErr, "test").kind).toBe("permanent");

      const notNullErr = { code: "23502", message: "null value violates not-null constraint" };
      expect(classifyPgError(notNullErr, "test").kind).toBe("permanent");

      const checkErr = { code: "23514", message: "check constraint failed" };
      expect(classifyPgError(checkErr, "test").kind).toBe("permanent");
    });

    it("classifies data overflow / type exceptions as permanent", () => {
      const dataErr = { code: "22001", message: "value too long for type character varying" };
      expect(classifyPgError(dataErr, "test").kind).toBe("permanent");
    });

    it("classifies connection failures as transient", () => {
      const connErr = { code: "08006", message: "connection failure" };
      expect(classifyPgError(connErr, "test").kind).toBe("transient");

      const refErr = { code: "ECONNREFUSED", message: "connection refused" };
      expect(classifyPgError(refErr, "test").kind).toBe("transient");
    });
  });
});
