import type { TransformOp } from "./job-spec.js";
import { SyncError } from "./types.js";
import type { RecordData, Transformer } from "./types.js";
import { typeName } from "./value.js";

type Step = (record: RecordData) => void;

// Every failure here is `permanent`: the same record will fail the same way on
// retry. Messages name fields and types, never values, because they end up in
// dead letters and logs.
export function compileTransform(ops: readonly TransformOp[]): Transformer {
  const steps = ops.map((op, index) => compileOp(op, index));
  return (record) => {
    // Shallow copy is enough: no operation mutates nested values.
    const out: RecordData = { ...record };
    for (const step of steps) step(out);
    return out;
  };
}

function present(record: RecordData, field: string): boolean {
  return Object.hasOwn(record, field) && record[field] !== undefined;
}

function compileOp(op: TransformOp, index: number): Step {
  const fail = (message: string): never => {
    throw new SyncError("permanent", `transform[${index}] ${op.op}: ${message}`);
  };

  switch (op.op) {
    case "rename":
      return (r) => {
        if (!present(r, op.from)) fail(`field '${op.from}' is missing`);
        const value = r[op.from];
        if (op.from !== op.to) delete r[op.from];
        r[op.to] = value;
      };

    case "concat":
      return (r) => {
        const parts = op.from.map((field) => {
          const value = r[field];
          if (value === undefined || value === null) fail(`field '${field}' is missing or null`);
          if (value instanceof Date) return value.toISOString();
          if (typeof value === "object") fail(`field '${field}' is ${typeName(value)}, expected a scalar`);
          return String(value);
        });
        r[op.to] = parts.join(op.separator);
      };

    case "set":
      return (r) => {
        r[op.field] = op.value;
      };

    case "cast":
      return (r) => {
        if (!present(r, op.field)) fail(`field '${op.field}' is missing`);
        const value = r[op.field];
        // null passes through untouched: nullable columns are common and a
        // cast cannot meaningfully invent a value for them.
        if (value === null) return;
        r[op.field] = cast(value, op.as, (m) => fail(`field '${op.field}' ${m}`));
      };

    case "drop":
      return (r) => {
        for (const field of op.fields) delete r[field];
      };

    default: {
      const unreachable: never = op;
      throw new Error(`unhandled transform op: ${JSON.stringify(unreachable)}`);
    }
  }
}

function cast(value: unknown, as: "string" | "number" | "boolean" | "date", fail: (message: string) => never): unknown {
  switch (as) {
    case "string":
      if (value instanceof Date) return value.toISOString();
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
      }
      return fail(`cannot be cast from ${typeName(value)} to string`);

    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value.trim());
        if (Number.isFinite(n)) return n;
      }
      return fail(`cannot be cast from ${typeName(value)} to number`);
    }

    case "boolean": {
      if (typeof value === "boolean") return value;
      if (value === 0 || value === 1) return value === 1;
      if (typeof value === "string") {
        const s = value.trim().toLowerCase();
        if (s === "true") return true;
        if (s === "false") return false;
      }
      return fail(`cannot be cast from ${typeName(value)} to boolean`);
    }

    case "date": {
      if (typeof value === "string" || typeof value === "number" || value instanceof Date) {
        const d = value instanceof Date ? value : new Date(value);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
      }
      return fail(`cannot be cast from ${typeName(value)} to date`);
    }
  }
}
