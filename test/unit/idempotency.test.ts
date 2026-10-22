import { describe, expect, it } from "vitest";
import { canonicalJson, contentHash, idempotencyKey } from "../../src/core/idempotency.js";

describe("canonicalJson", () => {
  it("is independent of key order, including nested objects", () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: 1 }, b: 1 }));
  });

  it("drops undefined object values", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("keeps array order significant", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("does not let NaN collide with null or a bigint with a string", () => {
    expect(canonicalJson({ v: Number.NaN })).not.toBe(canonicalJson({ v: null }));
    expect(canonicalJson({ v: 1n })).not.toBe(canonicalJson({ v: "1" }));
  });

  it("serializes dates as ISO strings and tolerates invalid dates", () => {
    expect(canonicalJson({ d: new Date("2024-01-01T00:00:00Z") })).toBe('{"d":"2024-01-01T00:00:00.000Z"}');
    expect(() => canonicalJson({ d: new Date("nope") })).not.toThrow();
  });

  it("rejects values that cannot be represented", () => {
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
  });
});

describe("contentHash and idempotencyKey", () => {
  it("is stable for equal content and changes when content changes", () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  it("depends on job, record key and content hash independently", () => {
    const h = contentHash({ a: 1 });
    const base = idempotencyKey("job1", "rec1", h);
    expect(base).toBe(idempotencyKey("job1", "rec1", h));
    expect(base).not.toBe(idempotencyKey("job2", "rec1", h));
    expect(base).not.toBe(idempotencyKey("job1", "rec2", h));
    expect(base).not.toBe(idempotencyKey("job1", "rec1", contentHash({ a: 2 })));
  });

  it("cannot be collided by moving a delimiter between fields", () => {
    expect(idempotencyKey("a|b", "c", "h")).not.toBe(idempotencyKey("a", "b|c", "h"));
  });
});
