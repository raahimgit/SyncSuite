import { describe, expect, it } from "vitest";
import { createValidator } from "../../src/core/validator.js";
import { SyncError } from "../../src/core/types.js";

describe("createValidator", () => {
  it("accepts everything when no rules are configured", () => {
    expect(createValidator(undefined).validate({ anything: 1 })).toEqual({ ok: true });
  });

  const validator = createValidator({
    fields: {
      id: { type: "number", required: true },
      email: { type: "string", required: false, pattern: "^[^@\\s]+@[^@\\s]+$", maxLength: 20 },
      name: { required: false, minLength: 3 },
    },
  });

  it("passes a conforming record", () => {
    expect(validator.validate({ id: 1, email: "a@b.co", name: "Ada" })).toEqual({ ok: true });
  });

  it("reports required, type, pattern and length issues with field paths", () => {
    const result = validator.validate({ email: 5, name: "Al" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => `${i.path}:${i.rule}`).sort()).toEqual(["email:type", "id:required", "name:minLength"]);
  });

  it("treats null like a missing value for required fields only", () => {
    const r = validator.validate({ id: null, email: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]?.rule).toBe("required");
  });

  it("never includes the offending value in an issue message", () => {
    const r = validator.validate({ id: 1, email: "very-secret-not-an-email" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.stringify(r.issues)).not.toContain("very-secret");
  });

  it("rejects non-finite numbers and unparseable dates", () => {
    const v = createValidator({ fields: { n: { type: "number", required: false }, d: { type: "date", required: false } } });
    expect(v.validate({ n: Number.NaN }).ok).toBe(false);
    expect(v.validate({ d: "garbage" }).ok).toBe(false);
    expect(v.validate({ n: 1, d: "2024-05-06" }).ok).toBe(true);
  });

  it("throws a fatal error at creation for an invalid pattern", () => {
    try {
      createValidator({ fields: { x: { required: false, pattern: "(" } } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SyncError);
      expect((err as SyncError).kind).toBe("fatal");
    }
  });
});
