import { describe, expect, it } from "vitest";
import { parseJobSpec } from "../../src/core/job-spec.js";
import { compileTransform } from "../../src/core/transform.js";
import { SyncError } from "../../src/core/types.js";

function transformOf(ops: unknown[]) {
  const spec = parseJobSpec({ name: "t", source: { type: "x" }, destination: { type: "y" }, transform: ops });
  return compileTransform(spec.transform);
}

describe("compileTransform", () => {
  it("builds full_name from first_name and last_name and drops the originals", () => {
    const t = transformOf([
      { op: "concat", from: ["first_name", "last_name"], to: "full_name" },
      { op: "drop", fields: ["first_name", "last_name"] },
    ]);
    expect(t({ id: 1, first_name: "Ada", last_name: "Lovelace" })).toEqual({ id: 1, full_name: "Ada Lovelace" });
  });

  it("does not mutate the input record", () => {
    const input = { a: 1, b: 2 };
    transformOf([{ op: "rename", from: "a", to: "c" }, { op: "drop", fields: ["b"] }])(input);
    expect(input).toEqual({ a: 1, b: 2 });
  });

  it("renames, sets, and tolerates dropping missing fields", () => {
    const t = transformOf([
      { op: "rename", from: "a", to: "b" },
      { op: "set", field: "source", value: "synckit" },
      { op: "drop", fields: ["nope"] },
    ]);
    expect(t({ a: 1 })).toEqual({ b: 1, source: "synckit" });
  });

  it("fails permanently when a renamed field is missing, without leaking other values", () => {
    const t = transformOf([{ op: "rename", from: "missing", to: "x" }]);
    try {
      t({ token: "super-secret-value" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SyncError);
      expect((err as SyncError).kind).toBe("permanent");
      expect((err as SyncError).message).not.toContain("super-secret-value");
      expect((err as SyncError).message).toContain("'missing'");
    }
  });

  it("fails permanently when a concat part is null", () => {
    const t = transformOf([{ op: "concat", from: ["a", "b"], to: "c" }]);
    expect(() => t({ a: "x", b: null })).toThrow(/missing or null/);
  });

  describe("cast", () => {
    it("casts numbers from strings and rejects non-numeric text", () => {
      const t = transformOf([{ op: "cast", field: "n", as: "number" }]);
      expect(t({ n: " 42 " })).toEqual({ n: 42 });
      expect(() => t({ n: "abc" })).toThrow(/to number/);
      expect(() => t({ n: "" })).toThrow(/to number/);
      expect(() => t({ n: true })).toThrow(/to number/);
    });

    it("casts booleans from strict spellings only", () => {
      const t = transformOf([{ op: "cast", field: "b", as: "boolean" }]);
      expect(t({ b: "TRUE" })).toEqual({ b: true });
      expect(t({ b: 0 })).toEqual({ b: false });
      expect(() => t({ b: "yes" })).toThrow(/to boolean/);
    });

    it("normalizes dates to ISO strings and rejects invalid ones", () => {
      const t = transformOf([{ op: "cast", field: "d", as: "date" }]);
      expect(t({ d: 0 })).toEqual({ d: "1970-01-01T00:00:00.000Z" });
      expect(t({ d: new Date("2024-01-02T03:04:05Z") })).toEqual({ d: "2024-01-02T03:04:05.000Z" });
      expect(() => t({ d: "not a date" })).toThrow(/to date/);
    });

    it("leaves null alone but fails on a missing field", () => {
      const t = transformOf([{ op: "cast", field: "n", as: "number" }]);
      expect(t({ n: null })).toEqual({ n: null });
      expect(() => t({})).toThrow(/missing/);
    });
  });
});
