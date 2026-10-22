import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseJobSpec } from "../../core/job-spec.js";
import type { JobSpec } from "../../core/job-spec.js";

export interface ValidationReport {
  filePath: string;
  valid: boolean;
  spec?: JobSpec;
  errors: string[];
  warnings: string[];
}

export function loadJobFile(filePath: string): unknown {
  const resolved = resolve(process.cwd(), filePath);
  const raw = readFileSync(resolved, "utf8");

  if (filePath.endsWith(".json")) {
    return JSON.parse(raw);
  }
  // Default to YAML (handles both .yaml, .yml, or unspecified extension)
  return parseYaml(raw);
}

export function auditJobSpec(spec: JobSpec): string[] {
  const warnings: string[] = [];

  // 1. Audit REST destination idempotency
  if (spec.destination.type === "rest") {
    const config = spec.destination.config as Record<string, unknown>;
    const method = String(config.method ?? "POST").toUpperCase();
    const hasIdempotencyHeader = Boolean(config.idempotencyKeyHeader);

    if (method === "POST" && !hasIdempotencyHeader) {
      warnings.push(
        "Destination is REST with method POST but lacks 'idempotencyKeyHeader'. Network retries or worker restarts may cause duplicate record creation.",
      );
    }

    if (config.allowPrivateNetworks === true) {
      warnings.push(
        "Destination allows private networks ('allowPrivateNetworks: true'). Ensure target URLs are trusted to prevent SSRF vulnerabilities.",
      );
    }
  }

  // 2. Audit REST source SSRF
  if (spec.source.type === "rest") {
    const config = spec.source.config as Record<string, unknown>;
    if (config.allowPrivateNetworks === true) {
      warnings.push(
        "Source allows private networks ('allowPrivateNetworks: true'). Ensure target URLs are trusted to prevent SSRF vulnerabilities.",
      );
    }
  }

  // 3. Audit plaintext credentials in configs
  const checkPlaintextSecrets = (cfg: Record<string, unknown>, path: string) => {
    for (const [key, val] of Object.entries(cfg)) {
      if (typeof val === "string") {
        const lowerKey = key.toLowerCase();
        const isNonSensitive =
          lowerKey === "keycolumn" ||
          lowerKey === "cursorcolumn" ||
          lowerKey === "idempotencykeyheader" ||
          lowerKey === "keyderivedurl";
        const isSensitive =
          !isNonSensitive &&
          (lowerKey.includes("password") ||
            lowerKey.includes("secret") ||
            lowerKey.includes("token") ||
            lowerKey === "key" ||
            lowerKey.includes("apikey") ||
            lowerKey.includes("api_key") ||
            lowerKey.includes("privatekey") ||
            lowerKey.includes("authkey"));

        if (isSensitive && !val.startsWith("$") && val.length > 0) {
          warnings.push(
            `Possible plaintext credential in ${path}.${key}. Prefer referencing secrets with { "$env": "NAME" }.`,
          );
        }
      } else if (val && typeof val === "object" && !Array.isArray(val)) {
        if (!("$env" in val)) {
          checkPlaintextSecrets(val as Record<string, unknown>, `${path}.${key}`);
        }
      }
    }
  };

  checkPlaintextSecrets(spec.source.config, "source.config");
  checkPlaintextSecrets(spec.destination.config, "destination.config");

  return warnings;
}

export function validateJobFile(filePath: string): ValidationReport {
  const resolved = resolve(process.cwd(), filePath);
  const errors: string[] = [];
  const warnings: string[] = [];

  let rawData: unknown;
  try {
    rawData = loadJobFile(resolved);
  } catch (err) {
    return {
      filePath: resolved,
      valid: false,
      errors: [`Failed to read or parse file: ${err instanceof Error ? err.message : String(err)}`],
      warnings: [],
    };
  }

  try {
    const spec = parseJobSpec(rawData);
    const auditWarnings = auditJobSpec(spec);
    warnings.push(...auditWarnings);

    return {
      filePath: resolved,
      valid: true,
      spec,
      errors,
      warnings,
    };
  } catch (err) {
    if (err && typeof err === "object" && "issues" in err) {
      const zErr = err as { issues: Array<{ path: (string | number)[]; message: string }> };
      for (const issue of zErr.issues) {
        errors.push(`${issue.path.join(".")}: ${issue.message}`);
      }
    } else {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    return {
      filePath: resolved,
      valid: false,
      errors,
      warnings,
    };
  }
}
