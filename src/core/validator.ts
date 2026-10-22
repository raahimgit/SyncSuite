import type { JobSpec } from "./job-spec.js";
import { SyncError } from "./types.js";
import type { RecordData, ValidationIssue, ValidationResult, Validator } from "./types.js";
import { typeName } from "./value.js";

type FieldRule = NonNullable<JobSpec["validation"]>["fields"][string];

interface CompiledRule {
  rule: FieldRule;
  pattern: RegExp | undefined;
}

function matchesType(value: unknown, type: "string" | "number" | "boolean" | "date"): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      if (value instanceof Date) return !Number.isNaN(value.getTime());
      return typeof value === "string" && !Number.isNaN(Date.parse(value));
  }
}

// Rules apply to top-level fields only. Issue messages describe the rule that
// failed and never echo the offending value.
//
// Patterns come from the job author, who is trusted, but a pathological
// pattern can still stall the event loop on large strings. Authors are
// responsible for patterns that cannot backtrack catastrophically.
export function createValidator(config: JobSpec["validation"]): Validator {
  const compiled = new Map<string, CompiledRule>();
  for (const [field, rule] of Object.entries(config?.fields ?? {})) {
    let pattern: RegExp | undefined;
    if (rule.pattern !== undefined) {
      try {
        pattern = new RegExp(rule.pattern);
      } catch {
        throw new SyncError("fatal", `validation.fields.${field}.pattern is not a valid regular expression`);
      }
    }
    compiled.set(field, { rule, pattern });
  }

  return {
    validate(record: RecordData): ValidationResult {
      const issues: ValidationIssue[] = [];
      for (const [path, { rule, pattern }] of compiled) {
        const value = record[path];
        if (value === undefined || value === null) {
          if (rule.required) issues.push({ path, rule: "required", message: "field is required" });
          continue;
        }
        if (rule.type !== undefined && !matchesType(value, rule.type)) {
          issues.push({ path, rule: "type", message: `expected ${rule.type}, got ${typeName(value)}` });
          continue;
        }
        if (typeof value !== "string") continue;
        if (rule.minLength !== undefined && value.length < rule.minLength) {
          issues.push({ path, rule: "minLength", message: `length ${value.length} is below minimum ${rule.minLength}` });
        }
        if (rule.maxLength !== undefined && value.length > rule.maxLength) {
          issues.push({ path, rule: "maxLength", message: `length ${value.length} exceeds maximum ${rule.maxLength}` });
        }
        if (pattern !== undefined && !pattern.test(value)) {
          issues.push({ path, rule: "pattern", message: "value does not match the required pattern" });
        }
      }
      return issues.length === 0 ? { ok: true } : { ok: false, issues };
    },
  };
}
