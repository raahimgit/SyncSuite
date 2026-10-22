import { z } from "zod";

// Secrets are never written into job files. A reference is resolved from the
// process environment at run time and is never persisted or logged.
export const secretRefSchema = z.strictObject({ $env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) });
export type SecretRef = z.infer<typeof secretRefSchema>;

const connectorSchema = z.strictObject({
  type: z.string().min(1),
  // Validated by the connector itself once it is resolved from `type`.
  config: z.record(z.string(), z.unknown()).default({}),
});

const fieldName = z.string().min(1);

// Job files carry declarative operations only. Executable expressions in a
// config file would turn a job definition into a code-execution surface.
export const transformOpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("rename"), from: fieldName, to: fieldName }),
  z.strictObject({ op: z.literal("concat"), from: z.array(fieldName).min(2), to: fieldName, separator: z.string().default(" ") }),
  z.strictObject({ op: z.literal("set"), field: fieldName, value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
  z.strictObject({ op: z.literal("cast"), field: fieldName, as: z.enum(["string", "number", "boolean", "date"]) }),
  z.strictObject({ op: z.literal("drop"), fields: z.array(fieldName).min(1) }),
]);
export type TransformOp = z.infer<typeof transformOpSchema>;

const fieldRuleSchema = z.strictObject({
  type: z.enum(["string", "number", "boolean", "date"]).optional(),
  required: z.boolean().default(false),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  pattern: z.string().optional(),
});

const retrySchema = z
  .strictObject({
    maxAttempts: z.number().int().min(1).max(20).default(5),
    baseDelayMs: z.number().int().min(1).default(500),
    maxDelayMs: z.number().int().min(1).default(30_000),
    jitter: z.enum(["full", "none"]).default("full"),
  })
  .refine((r) => r.maxDelayMs >= r.baseDelayMs, {
    message: "maxDelayMs must be >= baseDelayMs",
    path: ["maxDelayMs"],
  });

const rateLimitSchema = z.strictObject({
  requestsPerSecond: z.number().positive(),
  burst: z.number().int().min(1).optional(),
});

export const jobSpecSchema = z.strictObject({
  version: z.literal(1).default(1),
  description: z.string().optional(),
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, "lowercase letters, digits, '-' and '_' only; max 63 chars"),
  source: connectorSchema,
  destination: connectorSchema,
  transform: z.array(transformOpSchema).default([]),
  validation: z.strictObject({ fields: z.record(z.string(), fieldRuleSchema) }).optional(),
  batchSize: z.number().int().min(1).max(10_000).default(500),
  concurrency: z.number().int().min(1).max(64).default(4),
  onRecordFailure: z.enum(["dead_letter", "halt"]).default("dead_letter"),
  circuitBreaker: z.strictObject({ maxConsecutiveFailures: z.number().int().min(1).default(20) }).default({ maxConsecutiveFailures: 20 }),
  retry: retrySchema.default({ maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 30_000, jitter: "full" }),
  rateLimit: rateLimitSchema.optional(),
});

export type JobSpec = z.infer<typeof jobSpecSchema>;
export type JobSpecInput = z.input<typeof jobSpecSchema>;

export function parseJobSpec(input: unknown): JobSpec {
  return jobSpecSchema.parse(input);
}
