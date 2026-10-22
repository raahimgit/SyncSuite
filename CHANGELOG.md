# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-06

### Added
- **Core Engine & Architecture**:
  - Incremental data synchronization engine with batch barriers and fenced checkpoint commits.
  - Advisory-locked transactional PostgreSQL state database migrations.
  - Fencing lease protocol with database-clock expiry preventing worker split-brain.
  - Delivery ledger tracking canonical JSON content hashes (`SHA-256`) to skip unchanged writes.
  - Declarative transformation engine supporting `rename`, `set`, `concat`, `drop`, and `cast`.
  - Schema validation engine supporting `required`, `type`, `pattern`, `minLength`, `maxLength`.
  - Exponential backoff retry engine with full jitter and `Retry-After` header adherence.
  - Token-bucket rate limiter with burst control and serialized reservation queue.
  - Consecutive-failure circuit breaker protecting downstream destinations.
- **Connectors**:
  - PostgreSQL Source with keyset pagination on `(cursor_col, key_col)` and DB-clock `safetyLagMs`.
  - PostgreSQL Destination with atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE IS DISTINCT FROM` upserts and dry-run planning.
  - REST Destination supporting `POST`, `PUT`, `PATCH`, key-derived URLs, and `Idempotency-Key` headers.
  - REST Source supporting cursor, page/offset, and Link-header pagination.
  - Socket-level SSRF protection pre-validating DNS, pinning connection IPs, and blocking private/link-local/metadata ranges.
  - Deep environment variable secret resolution via `{ "$env": "VAR_NAME" }`.
- **CLI & HTTP REST API**:
  - CLI binary `syncsuite` (aliased as `synckit`) supporting `init`, `validate`, `sync`, `jobs`, `status`, `retry`, `logs`, and `server`.
  - HTTP REST API with Bearer token authentication, localhost bind by default, and active run cancellation with `AbortController`.
  - OpenAPI 3.1 specification exposed at `/openapi.json` and `/openapi.yaml`.
  - Strongly-typed TypeScript client SDK (`SyncSuiteClient` / `SyncKitClient`).
- **Observability, Recovery & Testing**:
  - Structured JSON logger (`JsonLogger`) with automatic credential, password, token, URL, and header redaction filter (`RedactionFilter`).
  - Prometheus metrics exposition endpoint at `GET /metrics` and JSON snapshot endpoint at `GET /metrics.json`.
  - Stuck-run sweeper `sweepStuckRuns()` to reclaim expired worker leases and mark dead runs as `interrupted`.
  - Retention pruning methods for runs, run events, resolved dead letters, and delivery ledger entries.
  - Dead-letter payload redaction policy to protect sensitive customer data in dead-letter storage.
  - Comprehensive unit test suite with 182 passing tests across 21 test files.
  - Reproducible benchmark suite measuring throughput, retry overhead, and checkpoint recovery latency.
  - Production multi-stage Dockerfile and Docker Compose configurations.

## [Unreleased]

### Added
- **Native S3 Destination Connector** (`s3`):
  - Zero-dependency AWS Signature Version 4 (SigV4) implementation using Node.js built-in `node:crypto`.
  - Compatible with AWS S3, Cloudflare R2, MinIO, Wasabi, and Backblaze B2.
  - Supports both standard JSON and NDJSON object streaming formats.
  - Key-derived pathing (`{prefix}{key}.json` / `.ndjson`) and pre-write `HEAD` inspection for `plan()`.
  - Added CLI template `postgres-to-s3` for `syncsuite init`.
- **CLI Live Streaming**:
  - Active real-time batch committed progress and retry alerts logged to stdout during execution.

### Fixed
- **PostgreSQL Keyset Microsecond Precision**:
  - Preserved full database timestamp precision via `${cursorCol}::text AS __syncsuite_cursor_raw` to eliminate truncation to millisecond resolution that caused infinite pagination loops on cloud Postgres databases.
- **JobRunner Infinite Loop Guard**:
  - Added strict check in `JobRunner` ensuring batch cursor advances beyond previous checkpoint, halting immediately if a custom connector returns identical cursors.
- **Connection Pool Stability & Deprecation Warning**:
  - Removed un-awaited `SET search_path` query on `connect` event in `createPool`, eliminating Node.js `pg` deprecation warnings and multiplexed socket collisions with Supabase/Supavisor poolers.
  - Added `connectionTimeoutMillis: 10_000` and optimized connector pool limits to prevent connection starvation on cloud databases.

