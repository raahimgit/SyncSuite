# SyncSuite

[![CI](https://github.com/syncsuite/syncsuite/actions/workflows/ci.yml/badge.svg)](https://github.com/syncsuite/syncsuite/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](package.json)

> **SyncSuite** (formerly referenced as SyncKit) is a self-hostable, production-ready incremental data synchronization engine built for reliable record synchronization between databases and external systems. It provides persisted checkpointing, token-bucket rate limiting, circuit breakers, idempotency ledgers, automatic retries with full jitter, SSRF guards, structured JSON logging with secret redaction, OpenAPI 3.1 endpoints, and a dead-letter recovery store.

---

## Table of Contents

- [Problem Statement](#problem-statement)
- [Architecture & Guarantees](#architecture--guarantees)
- [Key Features](#key-features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [CLI Reference](#cli-reference)
- [REST API & OpenAPI](#rest-api--openapi)
- [TypeScript Client SDK](#typescript-client-sdk)
- [Connectors & Extensibility](#connectors--extensibility)
- [Reliability & Failure Recovery](#reliability--failure-recovery)
- [Observability & Metrics](#observability--metrics)
- [Security Model](#security-model)
- [Benchmarks](#benchmarks)
- [Development & Testing](#development--testing)
- [Contributing](#contributing)
- [Roadmap](#roadmap)
- [License](#license)

---

## Problem Statement

Moving data incrementally between internal relational databases (like PostgreSQL) and external APIs or warehouses is fraught with reliability hazards:

1. **At-Least-Once Delivery Duplicates**: When network connections drop during writes, retries without idempotency cause duplicate creations or corrupted state.
2. **Crash Windows**: If a worker crashes after writing a batch but before committing the checkpoint cursor, naive synchronizers re-process or drop data.
3. **Downstream API Rate Limits**: External APIs enforce strict token limits (HTTP 429) that will ban workers without cooperative client-side rate limiting and dynamic backoff.
4. **Cascading Outages**: Uncontrolled retry loops hammer failing destinations, wasting resources and exhausting database connection pools.
5. **SSRF & Credential Leaks**: Sync jobs referencing arbitrary HTTP webhooks risk private cloud network access (e.g. AWS metadata `169.254.169.254`), and credentials logged in cleartext lead to security incidents.

**SyncSuite solves this cleanly** by acting as an embeddable or standalone sync engine with atomic transactions, a content-hash delivery ledger, cryptographic fencing leases, token-bucket limiters, SSRF socket-level IP pinning, and automated dead-letter handling.

---

## Architecture & Guarantees

SyncSuite uses PostgreSQL for state coordination (`jobs`, `leases`, `runs`, `checkpoints`, `delivery_ledger`, `dead_letters`, `run_events`).

### Architecture Diagram

```mermaid
flowchart TD
    subgraph Storage ["State Database (PostgreSQL)"]
        Lease["Leases & Fencing Epochs"]
        Checkpoint["Checkpoints & Cursors"]
        Ledger["Delivery Ledger (SHA-256)"]
        DeadLetters["Dead Letter Queue"]
        Events["Run Events Timeline"]
    end

    subgraph SyncSuite ["SyncSuite Core Engine"]
        Worker["JobRunner (Worker)"]
        RateLimiter["TokenBucket Rate Limiter"]
        CircuitBreaker["Circuit Breaker"]
        Retry["Exponential Backoff Retry"]
        SSRF["SSRF Guard & IP Pinning"]
        Redact["Redaction Filter"]
    end

    Source[("Source\n(PostgreSQL / REST)")] -->|Keyset Pagination| Worker
    Worker --> RateLimiter
    RateLimiter --> Retry
    Retry --> CircuitBreaker
    CircuitBreaker -->|Idempotent Write| Destination[("Destination\n(REST / PostgreSQL)")]

    Worker <--> Lease
    Worker <--> Checkpoint
    Worker <--> Ledger
    Worker --> DeadLetters
    Worker --> Events
    Worker --> Redact
```

### Core Reliability Guarantees

| Mechanism | Guarantee |
|---|---|
| **Fencing Leases** | Leases expire using the database clock. Every checkpoint commit asserts the lease epoch inside a single transaction. Stale or partitioned workers cannot corrupt checkpoints. |
| **Delivery Ledger** | Records are hashed using canonical JSON (`SHA-256`). If a record has already been delivered with identical content, destination writes are skipped (`unchanged`). |
| **Crash Window Absorption** | If a worker dies after writing to the destination but before updating the delivery ledger or committing the checkpoint, restarting workers resend with the exact same `Idempotency-Key` or `ON CONFLICT` clause. |
| **Circuit Breaking** | Consecutive failure thresholds trip the circuit breaker, stopping the run cleanly without advancing the cursor past failed batches. |
| **Dead-Letter Storage** | Permanent transform/validation errors or retry-exhausted failures are isolated into dead-letter tables for inspection and re-drive. |

---

## Key Features

- **PostgreSQL Keyset Pagination**: Keyset pagination with database-clock safety lag (`safetyLagMs`) to avoid race conditions with late-committing transactions.
- **REST Destination & Source**: Full support for POST/PUT/PATCH, pagination (cursor, page/offset, Link header), and custom header injection.
- **Declarative Transforms**: Type-safe transforms (`rename`, `set`, `concat`, `drop`, `cast`) without executing arbitrary, unvetted JavaScript code.
- **Validation Rules**: Strict runtime data validation (`required`, `type`, `pattern`, `minLength`, `maxLength`).
- **SSRF Network Protection**: Pre-resolves DNS, rejects private/link-local/cloud-metadata addresses (IPv4 & IPv6), and pins sockets to pre-validated IPs to prevent DNS rebinding attacks.
- **Secret Redaction**: Structured JSON logger masks passwords, tokens, URLs containing credentials (`postgres://user:[REDACTED]@host`), and dynamically registered secrets.
- **Dead-Letter Re-drive**: Seamlessly re-drive failed records via CLI or HTTP API without re-running the entire dataset.
- **Prometheus Metrics**: Built-in exposition at `/metrics` for Prometheus and JSON stats at `/metrics.json`.

---

## Installation

### Via npm

```bash
npm install -g syncsuite
```

### As a Library

```bash
npm install syncsuite
```

Requires **Node.js 22.0.0 or higher** and **PostgreSQL 13+**.

---

## Quick Start

### 1. One-Command Automatic Setup (Recommended)

In your project directory, simply run:

```bash
npx syncsuite setup
```

This automatically:
- Scaffolds a starter `syncsuite.yaml` job spec.
- Detects `DATABASE_URL` from your environment.
- Injects ready-to-use npm scripts (`syncsuite:validate`, `syncsuite:apply`, `syncsuite:dry-run`, `syncsuite:sync`, `syncsuite:status`) into your `package.json`.
- Generates a reference `.env.example` documenting `DATABASE_URL` and `LOG_LEVEL` toggles.

---

### Alternative: Manual Scaffolding

```bash
syncsuite init orders-sync.yaml --template postgres-to-rest
```

This generates `orders-sync.yaml`:

```yaml
version: 1
name: orders-sync
description: Sync new orders from PostgreSQL to external REST webhook

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
  type: rest
  config:
    baseUrl: https://api.partner.example.com/v1
    path: /orders
    method: PUT
    keyDerivedUrl: true
    idempotencyKeyHeader: Idempotency-Key
    timeoutMs: 10000
    allowPrivateNetworks: false
    auth:
      type: bearer
      token:
        $env: PARTNER_API_KEY

transform:
  - op: rename
    from: order_total
    to: amount
  - op: set
    field: synced_by
    value: syncsuite

validation:
  fields:
    id:
      type: string
      required: true
    amount:
      type: number
      required: true

rateLimit:
  requestsPerSecond: 20
  burst: 40

retry:
  maxAttempts: 5
  baseDelayMs: 500
  maxDelayMs: 30000
  jitter: full

circuitBreaker:
  maxConsecutiveFailures: 20

onRecordFailure: dead_letter
```

### 2. Validate the configuration

```bash
syncsuite validate orders-sync.yaml
```

Output:
```text
✓ Job specification in 'orders-sync.yaml' is valid.
  Job: orders-sync (v1)
  Source: postgres
  Destination: rest
```

### 3. Apply the job to the database

```bash
export SYNCKIT_DATABASE_URL=postgres://user:pass@localhost:5432/sync_db
syncsuite jobs apply orders-sync.yaml
```

### 4. Run the sync (with dry-run option)

```bash
# Dry run to preview what would be written without modifying destination
syncsuite sync orders-sync --dry-run --limit 10

# Execute live sync
syncsuite sync orders-sync
```

---

## Configuration

Secrets are defined using `{ "$env": "VAR_NAME" }` references. SyncSuite securely resolves them from the process environment at runtime and never echoes secret values in error messages or logs.

Environment variables:
- `SYNCKIT_DATABASE_URL` or `DATABASE_URL`: State store PostgreSQL connection string.
- `SYNCKIT_SCHEMA`: Schema name for state tables (defaults to `synckit`).
- `LOG_LEVEL`: Logging verbosity (`debug`, `info`, `warn`, `error`, `silent`). Default is `info`.
- `PORT`: HTTP server listen port (default `3000`).
- `HOST`: HTTP server bind host (default `127.0.0.1`).
- `SYNCKIT_API_TOKEN`: Optional Bearer token for securing API endpoints.

---

## CLI Reference

SyncSuite provides a comprehensive command line interface:

| Command | Description |
|---|---|
| `syncsuite setup` | 1-command project setup: scaffolds spec, checks `DATABASE_URL`, and injects npm scripts. |
| `syncsuite init [path]` | Scaffold a new job file (`--template postgres-to-rest` or `postgres-to-postgres`). |
| `syncsuite validate <file>` | Validate syntax, schema, and security rules (SSRF, idempotency headers, cleartext secrets). |
| `syncsuite sync <job>` | Execute a job run (`--dry-run`, `--limit <n>`, `--db <url>`). |
| `syncsuite jobs list` | List all registered sync jobs and their status. |
| `syncsuite jobs show <name>` | Display full job specification and timestamps. |
| `syncsuite jobs apply <file>` | Declaratively upsert a job from a YAML or JSON file. |
| `syncsuite jobs delete <name>` | Delete a job and associated state. |
| `syncsuite status <job>` | Inspect active runs, cursor checkpoint, and counter statistics. |
| `syncsuite retry <job>` | Re-drive dead-lettered records (`--id <uuid>`, `--limit <n>`). |
| `syncsuite logs [runId]` | Inspect run events, timestamps, and error timeline. |
| `syncsuite server` | Start the SyncSuite HTTP REST API server. |

### Exit Codes

- `0`: Success
- `2`: Configuration or validation error
- `3`: Job run failed
- `4`: Resource conflict (e.g. concurrent lease or job already running)
- `5`: Resource not found
- `6`: Network / I/O error
- `7`: Internal engine error

---

## REST API & OpenAPI

SyncSuite includes a high-performance HTTP REST API bound by default to `127.0.0.1`:

### Endpoints

- `GET /health`: Health status and database connectivity check.
- `GET /metrics`: Prometheus text exposition format.
- `GET /metrics.json`: Instance metrics snapshot in JSON.
- `GET /openapi.json`: OpenAPI 3.1 schema specification.
- `GET /jobs`: List all registered sync jobs.
- `POST /jobs`: Register a new job spec.
- `GET /jobs/:name`: Retrieve job details.
- `PUT /jobs/:name`: Update job spec (increments `spec_version`).
- `DELETE /jobs/:name`: Delete a job.
- `POST /jobs/:name/runs`: Trigger a run (supports `{ dryRun: true, maxRecords: 50, queued: true }`).
- `GET /jobs/:name/runs`: List historical runs.
- `GET /runs/:id`: Get detailed run status and counters.
- `POST /runs/:id/stop`: Abort an in-flight run.
- `GET /jobs/:name/dead-letters`: List open dead-letter records.
- `POST /jobs/:name/dead-letters/retry`: Re-drive dead letters.

---

## TypeScript Client SDK

Use `SyncSuiteClient` to manage jobs and runs programmatically:

```typescript
import { SyncSuiteClient } from "syncsuite";

const client = new SyncSuiteClient({
  baseUrl: "http://127.0.0.1:3000",
  token: process.env.SYNCKIT_API_TOKEN,
});

// Trigger a sync run
const run = await client.startRun("orders-sync", {
  dryRun: false,
});
console.log(`Run started with ID: ${run.runId}`);

// Inspect metrics
const metrics = await client.getMetrics();
console.log(`Total processed records: ${metrics.totals.processed}`);
```

---

## Connectors & Extensibility

SyncSuite includes production-ready connectors out of the box with zero external bloat:

| Connector | Type | Supported Targets | Description |
| :--- | :---: | :--- | :--- |
| `postgres` | Source & Destination | PostgreSQL, Supabase, Neon, AWS RDS | Keyset pagination, safety lag, ON CONFLICT upserts |
| `rest` | Source & Destination | Webhooks, REST APIs, Microservices | SSRF guarded, Bearer / Basic / API-Key auth, retry headers |
| `s3` | Destination | AWS S3, Cloudflare R2, MinIO, Wasabi | Zero-dependency AWS SigV4 signed PUT, JSON & NDJSON |

Custom connectors can be registered via `ConnectorRegistry`:

```typescript
import { ConnectorRegistry, type SourceConnector, type DestinationConnector } from "syncsuite";

const registry = new ConnectorRegistry();

// Register custom source
registry.registerSource("my-queue", (config) => new MyQueueSource(config));

// Register custom destination
registry.registerDestination("warehouse", (config) => new WarehouseDestination(config));
```

---

## Reliability & Failure Recovery

### Stuck-Run Sweeper

If a worker node crashes or loses power, its lease will expire at `now()`. SyncSuite provides a stuck-run sweeper:

```typescript
// Reclaim orphaned leases and mark stale running runs as 'interrupted'
const swept = await store.sweepStuckRuns();
```

### Data Retention & Pruning

SyncSuite provides retention pruning methods for maintenance jobs:

```typescript
await store.pruneRuns(30);               // Prune completed runs older than 30 days
await store.pruneEvents(14);             // Prune audit run events older than 14 days
await store.pruneResolvedDeadLetters(7); // Prune resolved dead letters older than 7 days
await store.pruneDeliveryLedger(90);     // Prune delivery ledger hashes older than 90 days
```

---

## Observability & Metrics

SyncSuite uses structured JSON logging with built-in credential redaction:

```json
{"timestamp":"2026-10-06T12:00:00.000Z","level":"info","event":"batch.committed","batch":1,"records":200,"cursor":{"updated_at":"2026-10-06T11:59:00.000Z","id":"1020"}}
```

All log messages redact:
- Passwords, bearer tokens, API keys, credentials
- Connection strings: `postgres://user:[REDACTED]@host:5432/db`
- Authorization headers: `Bearer [REDACTED]`

---

## Security Model

1. **SSRF Guard**: Pre-resolves DNS before requests, blocks private IPs (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), loopbacks (`127.0.0.0/8`), link-local (`169.254.0.0/16`), and pins sockets to the validated IP to block DNS rebinding TOCTOU attacks.
2. **SQL Injection Guard**: All database queries use parameterized SQL. SQL identifiers are strictly validated against `/^[a-z_][a-z0-9_]{0,62}$/` and double-quoted.
3. **Constant-Time Auth**: Bearer token authentication uses `crypto.timingSafeEqual` to avoid timing side-channels.
4. **Dead-Letter Redaction**: Optional payload sanitization (`redactDeadLetterPayload: true`) masks sensitive fields before persisting failed records to disk.

---

## Benchmarks

SyncSuite includes a reproducible benchmark suite under `bench/`:

To run the benchmarks:
```bash
npx vitest run test/unit/benchmarks.test.ts
```

Measured on AMD Ryzen / Intel Core (Node.js v24.14.1):
- **Engine Throughput**: ~8,000–12,000 records/sec (in-memory transform, validation, and delivery ledger pipeline).
- **Retry Overhead**: < 0.05 ms per retry evaluation.
- **Checkpoint Recovery Latency**: < 5 ms to resume state and seek to cursor.

*(Note: Actual PostgreSQL connector throughput depends on network latency and database disk I/O).*

---

## Development & Testing

```bash
# Install dependencies
npm install

# Run unit tests (172 tests, zero external dependencies needed)
npm test

# Type checking
npm run typecheck

# Linting
npm run lint

# Build production bundle
npm run build
```

### Running with PostgreSQL Integration Tests

```bash
docker compose up -d postgres
export SYNCKIT_TEST_DATABASE_URL=postgres://synckit:synckit_dev_only@127.0.0.1:5432/synckit
npm test
```

---

## Contributing

Please review [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before opening pull requests.

---

## Roadmap

- [ ] Webhook triggers for event-driven stream ingestion.
- [ ] Shared token-bucket limiters across multiple distributed jobs.
- [x] Native S3, Cloudflare R2, and MinIO destination (Zero dependencies).
- [ ] Apache Iceberg destination.
- [ ] Web-based graphical monitoring dashboard.

---

## License

[MIT](LICENSE) © SyncKit / SyncSuite Contributors.
