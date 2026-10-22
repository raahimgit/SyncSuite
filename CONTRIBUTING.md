# Contributing to SyncSuite

Thank you for your interest in contributing to SyncSuite! This document outlines our development practices, code standards, and workflows.

---

## 1. Development Setup

### Prerequisites

- **Node.js**: v22.0.0 or higher
- **npm**: v10.0.0 or higher
- **Docker** (optional, required only for running local PostgreSQL integration tests)

### Getting Started

```bash
# Clone the repository
git clone https://github.com/syncsuite/syncsuite.git
cd syncsuite

# Install dependencies
npm install

# Verify setup
npm run typecheck
npm run lint
npm test
```

---

## 2. Repository Structure

```text
syncsuite/
├── bench/                 # Performance benchmark scripts
├── docs/                  # Architecture & design specifications
├── src/
│   ├── api/               # HTTP server, OpenAPI 3.1 generator, routes
│   ├── cli/               # CLI commands, argument parsing, exit codes
│   ├── client/            # Typed TypeScript API client SDK
│   ├── connectors/        # Built-in connectors (PostgreSQL, REST, SSRF guard)
│   ├── core/              # Core runner, rate limiter, circuit breaker, retry, transforms
│   ├── db/                # PostgreSQL schema migrations, state store, pool helper
│   └── index.ts           # Public library exports
├── test/
│   ├── fixtures/          # Mock connectors and records
│   ├── helpers/           # Test database setup and teardown
│   ├── integration/       # Database and connector integration tests
│   └── unit/              # High-speed unit tests
└── package.json
```

---

## 3. Testing Guidelines

SyncSuite emphasizes rigorous testing:

- **Unit Tests**: Must run in-memory and execute rapidly without external network or database dependencies (`npm test`).
- **Integration Tests**: Test real PostgreSQL interactions (keyset pagination, advisory locking, checkpoint commits). Run with:
  ```bash
  docker compose up -d postgres
  export SYNCKIT_TEST_DATABASE_URL=postgres://synckit:synckit_dev_only@127.0.0.1:5432/synckit
  npm test
  ```
- **Coverage**: All new features, bug fixes, and failure recovery cases must include tests demonstrating the behavior.

---

## 4. Linting and Formatting

We use ESLint with TypeScript rules and `.editorconfig`.

```bash
# Run ESLint across the codebase
npm run lint

# Check TypeScript types
npm run typecheck
```

Code style rules:
- No unused variables or imports.
- Explicit return types on public APIs and exported functions.
- Preserve explicit error typing (`SyncError`, `ErrorKind`).
- Never log plaintext secrets or passwords.

---

## 5. Adding New Connectors

Connectors implement the `SourceConnector` or `DestinationConnector` interfaces found in `src/core/types.ts`.

### Implementing a Source Connector

1. Create `src/connectors/my-source.ts`.
2. Implement `SourceConnector`:
   - `open(signal: AbortSignal): Promise<void>`
   - `readBatch(from: Cursor | null, limit: number, signal: AbortSignal): Promise<ReadBatch>`
   - `close(): Promise<void>`
3. Return a `Cursor` that supports keyset seeking.
4. Classify errors appropriately (`transient`, `permanent`, `fatal`).
5. Register the factory in `ConnectorRegistry` in `src/connectors/index.ts`.

### Implementing a Destination Connector

1. Create `src/connectors/my-destination.ts`.
2. Implement `DestinationConnector`:
   - `open(signal: AbortSignal): Promise<void>`
   - `write(req: WriteRequest, signal: AbortSignal): Promise<WriteResult>`
   - `plan?(req: WriteRequest, signal: AbortSignal): Promise<PlannedWrite>`
   - `close(): Promise<void>`
3. Ensure writes are idempotent using `req.idempotencyKey`.
4. Register the factory in `ConnectorRegistry`.

---

## 6. Pull Requests and Commit Expectations

- **Branch naming**: Use descriptive branches like `feat/webhook-source`, `fix/lease-race-condition`.
- **Commit Messages**: Write concise, conventional commit messages:
  - `feat: add S3 parquet destination`
  - `fix: prevent timeout in pg keyset pagination`
  - `docs: update quick start instructions`
- **CI Requirements**: All checks (`typecheck`, `lint`, `test`, `build`) must pass cleanly before merge.

---

## 7. Reporting Bugs & Security Vulnerabilities

- **Bugs**: Open an issue on GitHub with reproduction steps, sample configuration (secrets redacted), and error logs.
- **Security Vulnerabilities**: For potential security vulnerabilities (e.g. SSRF bypasses, credential leak hazards), please contact the maintainers directly or use GitHub Private Vulnerability Reporting.
