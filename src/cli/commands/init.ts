import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export interface InitOptions {
  format?: "yaml" | "json";
  template?: "postgres-to-rest" | "postgres-to-postgres" | "postgres-to-s3";
  force?: boolean;
}

const TEMPLATE_PG_TO_REST_YAML = `# SyncSuite Job Specification
# Schema: PostgreSQL -> REST Destination
# Production logging: Set LOG_LEVEL in environment (info, warn, error, debug).
# In production, set LOG_LEVEL=warn or error to suppress routine batch logs.
version: 1
name: sync-users-to-api
description: Sync verified users from PostgreSQL to external REST API

source:
  type: postgres
  config:
    connectionString:
      $env: SOURCE_DATABASE_URL
    table: users
    keyColumn: id
    cursorColumn: updated_at
    batchSize: 100
    # Safety lag prevents late-committing transactions from being skipped
    safetyLagMs: 5000

destination:
  type: rest
  config:
    baseUrl: https://api.example.com/v1
    path: /users
    method: PUT
    # Key-derived URL appends the record key for natural idempotency: /users/{id}
    keyDerivedUrl: true
    idempotencyKeyHeader: Idempotency-Key
    timeoutMs: 10000
    # Restrict internal network SSRF
    allowPrivateNetworks: false
    auth:
      type: bearer
      token:
        $env: API_BEARER_TOKEN

transform:
  # Declarative transformations (rename, drop, set, concat, cast)
  - op: rename
    from: email_address
    to: email
  - op: drop
    field: hashed_password
  - op: set
    field: sync_source
    value: syncsuite

validation:
  fields:
    id:
      type: string
      required: true
    email:
      type: string
      required: true

rateLimit:
  requestsPerSecond: 25
  burst: 50

retry:
  maxAttempts: 5
  baseDelayMs: 500
  maxDelayMs: 30000
  jitter: full

circuitBreaker:
  maxConsecutiveFailures: 20

onRecordFailure: dead_letter
`;

const TEMPLATE_PG_TO_PG_YAML = `# SyncSuite Job Specification
# Schema: PostgreSQL -> PostgreSQL Replica
# Production logging: Set LOG_LEVEL in environment (info, warn, error, debug).
# In production, set LOG_LEVEL=warn or error to suppress routine batch logs.
version: 1
name: sync-orders-replica
description: Incremental sync of orders table to analytical PostgreSQL replica

source:
  type: postgres
  config:
    connectionString:
      $env: SOURCE_DATABASE_URL
    table: orders
    keyColumn: id
    cursorColumn: updated_at
    batchSize: 200
    safetyLagMs: 5000

destination:
  type: postgres
  config:
    connectionString:
      $env: REPLICA_DATABASE_URL
    table: orders_replica
    keyColumn: id

transform:
  - op: set
    field: replicated_at
    value: current_timestamp

validation:
  fields:
    id:
      type: string
      required: true
    total_cents:
      type: number

retry:
  maxAttempts: 4
  baseDelayMs: 500
  maxDelayMs: 15000
  jitter: full

circuitBreaker:
  maxConsecutiveFailures: 20

onRecordFailure: dead_letter
`;

const TEMPLATE_PG_TO_S3_YAML = `# SyncSuite Job Specification
# Schema: PostgreSQL -> S3 / Cloudflare R2 / MinIO
# Production logging: Set LOG_LEVEL in environment (info, warn, error, debug).
# In production, set LOG_LEVEL=warn or error to suppress routine batch logs.
version: 1
name: sync-orders-to-s3
description: Archive PostgreSQL orders to S3 cloud storage as JSON/NDJSON

source:
  type: postgres
  config:
    connectionString:
      $env: SOURCE_DATABASE_URL
    table: orders
    keyColumn: id
    cursorColumn: updated_at
    batchSize: 500
    safetyLagMs: 5000

destination:
  type: s3
  config:
    bucket: my-data-lake
    region: us-east-1
    prefix: orders/
    accessKeyId:
      $env: AWS_ACCESS_KEY_ID
    secretAccessKey:
      $env: AWS_SECRET_ACCESS_KEY
    format: json

transform:
  - op: set
    field: archived_at
    value: current_timestamp

retry:
  maxAttempts: 5
  baseDelayMs: 500
  maxDelayMs: 30000
  jitter: full

circuitBreaker:
  maxConsecutiveFailures: 20

onRecordFailure: dead_letter
`;

export interface DynamicTableConfig {
  table?: string;
  keyColumn?: string;
  cursorColumn?: string | null;
  dbVarName?: string;
  allTables?: string[];
}

export interface InitOptions {
  format?: "yaml" | "json";
  template?: "postgres-to-rest" | "postgres-to-postgres" | "postgres-to-s3";
  force?: boolean;
  tableConfig?: DynamicTableConfig;
}

export function buildDynamicPgToPgYaml(config: DynamicTableConfig): string {
  const table = config.table ?? "my_table";
  const keyCol = config.keyColumn ?? "id";
  const cursorCol = config.cursorColumn ?? "updated_at";
  const dbVar = config.dbVarName ?? "DATABASE_URL";

  return `# SyncSuite Job Specification
# Target: Auto-discovered table '${table}' -> '${table}_replica'
# Auto-created by SyncSuite setup based on your database schema.
version: 1
name: sync-${table}-replica
description: Incremental replication of ${table} to analytical replica

source:
  type: postgres
  config:
    connectionString:
      $env: ${dbVar}
    table: ${table}
    keyColumn: ${keyCol}
    cursorColumn: ${cursorCol}
    batchSize: 200
    safetyLagMs: 5000

destination:
  type: postgres
  config:
    connectionString:
      $env: ${dbVar}
    table: ${table}_replica
    keyColumn: ${keyCol}

transform:
  - op: set
    field: replicated_at
    value: current_timestamp

retry:
  maxAttempts: 4
  baseDelayMs: 500
  maxDelayMs: 15000
  jitter: full

circuitBreaker:
  maxConsecutiveFailures: 20

onRecordFailure: dead_letter
`;
}

export function generateJobTemplate(options: InitOptions = {}): string {
  if (options.tableConfig?.table) {
    return buildDynamicPgToPgYaml(options.tableConfig);
  }
  if (options.template === "postgres-to-s3") return TEMPLATE_PG_TO_S3_YAML;
  if (options.template === "postgres-to-postgres") return TEMPLATE_PG_TO_PG_YAML;
  return TEMPLATE_PG_TO_REST_YAML;
}

export function runInit(filePath?: string, options: InitOptions = {}): string {
  const format = options.format ?? (filePath?.endsWith(".json") ? "json" : "yaml");
  const defaultFileName = format === "json" ? "job.json" : "job.yaml";
  const targetPath = resolve(process.cwd(), filePath ?? defaultFileName);

  if (existsSync(targetPath) && !options.force) {
    throw new Error(`File already exists at ${targetPath}. Use --force to overwrite.`);
  }

  const yamlContent = generateJobTemplate(options);
  let finalContent = yamlContent;

  if (format === "json") {
    const parsed = parseYaml(yamlContent);
    finalContent = JSON.stringify(parsed, null, 2);
  }

  writeFileSync(targetPath, finalContent, "utf8");
  return targetPath;
}
