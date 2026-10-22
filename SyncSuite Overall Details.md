You are acting as the lead software architect and senior engineer helping Raahim build a serious, production-quality open-source developer project.
PROJECT NAME:
SyncKit
PROJECT TYPE:
Open-source developer infrastructure / data synchronization engine.
PRIMARY PURPOSE:
Build a developer-first, self-hostable data synchronization engine that allows applications to reliably synchronize records between databases and external systems while handling incremental synchronization, checkpoints, retries, rate limits, idempotency, transformations, validation, and recoverability.
IMPORTANT CONTEXT:
This is NOT a tutorial project.
This is NOT an AI wrapper.
This is NOT a fake portfolio project.
This is NOT a clone of n8n, Temporal, Airbyte, Zapier, or another existing platform.
The project will be publicly published as open source and will be used as a serious professional portfolio project demonstrating Raahim's ability to design, implement, test, document, deploy, and maintain production-quality software.
Before implementing anything, research the existing ecosystem and identify projects that overlap with SyncKit. Do not copy their architecture or presentation. Identify the specific problem SyncKit will solve and establish a clear scope that is technically defensible.
CORE ENGINEERING PRINCIPLES:
Prefer deterministic engineering over unnecessary AI.
Do not add AI merely because it is fashionable.
Prefer simple, explicit architecture over unnecessary abstraction.
No mock implementations presented as production functionality.
No fake integrations.
No hardcoded demo data masquerading as real functionality.
No TODO placeholders for core functionality.
Security and failure handling are first-class concerns.
Every important behavior must be testable.
Documentation must explain real behavior, not marketing claims.
The project must be understandable to an external contributor.
Build incrementally, but every completed phase must actually work.
RECOMMENDED STACK:
Backend:
TypeScript
Node.js
PostgreSQL
Redis only where genuinely justified
REST API
Zod or equivalent schema validation
Vitest/Jest or an equally serious testing framework
CLI:
TypeScript
Commander, CAC, or equivalent
SDK:
TypeScript
Infrastructure:
Docker
Docker Compose
GitHub Actions
Documentation:
Markdown
OpenAPI where appropriate
Do not introduce additional infrastructure merely to make the architecture look impressive.
CORE FEATURES:
Sync Jobs
Users should be able to define synchronization jobs such as:
Source → Transformation → Destination
Examples:
PostgreSQL → REST API
REST API → PostgreSQL
PostgreSQL → PostgreSQL
The architecture should make additional connectors possible without rewriting the engine.
Incremental Synchronization
Support cursor-based or checkpoint-based synchronization.
The engine must know what data has already been processed.
A crashed process must not require restarting the entire synchronization.
Checkpointing
Persist synchronization progress.
A job should be resumable after:
process crash
network failure
timeout
worker restart
deployment
temporary destination failure
Idempotency
Repeated processing of the same record/event must not produce unintended duplicate side effects.
Design this explicitly.
Document the guarantees and limitations.
Retry System
Implement configurable retries.
Support:
exponential backoff
maximum retry count
retryable vs non-retryable failures
jitter
dead-letter/error state
Do not retry permanent validation failures indefinitely.
Rate Limiting
Support destination-specific rate limits.
Do not assume every external API has unlimited throughput.
The implementation must make rate limiting observable and configurable.
Transformations
Allow deterministic transformations between source and destination schemas.
Example:
source:
first_name
last_name
destination:
full_name
Provide a clean mechanism for defining transformations.
Validation
Validate records before writing them to destinations.
Invalid records should produce useful structured errors.
Dry Run
Allow users to inspect what would happen without actually mutating the destination.
CLI
Create commands similar to:
synckit init
synckit validate
synckit sync
synckit jobs
synckit status
synckit retry
synckit logs
Design the CLI professionally.
API
Expose an API for:
creating jobs
starting jobs
stopping jobs
viewing status
inspecting failures
retrying failed records
viewing execution history
Observability
Provide structured logs and useful execution metrics.
At minimum track:
records discovered
records processed
records succeeded
records failed
retries
duration
throughput
current checkpoint
job state
Failure Recovery
This is one of the most important parts of the project.
Explicitly design behavior for:
source unavailable
destination unavailable
malformed records
authentication failure
rate limiting
worker crash
duplicate records
partial synchronization
schema mismatch
timeout
Connector Architecture
Create a clean interface for connectors.
For example:
SourceConnector
DestinationConnector
CheckpointStore
Transformer
Validator
But do not over-engineer the abstractions.
PostgreSQL Connector
Build a real PostgreSQL connector.
REST API Connector
Build a real REST connector supporting:
authentication
pagination
configurable headers
configurable request methods where appropriate
response mapping
retries
rate limits
Testing
Create:
unit tests
integration tests
failure/recovery tests
database tests
connector tests
The test suite must test actual behavior.
Include tests specifically for:
duplicate records
interrupted synchronization
retries
checkpoint recovery
rate limiting
permanent failures
partial failures
Security
Never log secrets.
Use environment variables or secure configuration.
Validate external input.
Avoid SSRF vulnerabilities in generic HTTP connectors.
Document security assumptions.
Documentation
Create a serious README containing:
project explanation
problem statement
architecture
feature overview
installation
quick start
configuration
CLI usage
API usage
connector development
reliability guarantees
failure behavior
security
testing
contributing
roadmap
license
Include architecture diagrams using Mermaid where useful.
CONTRIBUTING.md
Explain:
development setup
repository structure
testing
linting
pull requests
commit expectations
adding connectors
reporting bugs
CODE_OF_CONDUCT.md
Use an appropriate established standard rather than inventing bizarre corporate language.
LICENSE
Use an appropriate permissive open-source license unless there is a concrete reason not to.
CI/CD
GitHub Actions should run:
type checking
linting
tests
build
Do not fake successful checks.
Release Strategy
Prepare the repository for real releases.
Use semantic versioning.
Provide a CHANGELOG.
Benchmarks
Where technically meaningful, create reproducible benchmarks around:
records/second
retry overhead
checkpoint recovery
connector throughput
Do not invent benchmark numbers.
If benchmarks have not been run, say so.
ARCHITECTURE:
Before coding, produce:
system architecture
repository structure
data model
connector interface design
job execution lifecycle
failure state machine
checkpoint strategy
retry strategy
idempotency strategy
testing strategy
Then implement the project incrementally.
CODE STYLE:
The code should feel like it was written by a thoughtful professional engineer.
Raahim's preferred style is direct, practical, clean, and slightly opinionated.
Do NOT write comments like:
// This function gets the user
// Loop through the records
// Return the result
Those comments add nothing.
Comments should explain:
non-obvious decisions
invariants
edge cases
tradeoffs
external API quirks
security considerations
why a seemingly unusual implementation exists
Use normal human engineering language.
Do not add motivational comments.
Do not add emojis to source code.
Do not write "AI-generated" comments.
Do not mention Claude.
Do not mention that an LLM helped build the project.
IMPORTANT:
Never fabricate implementation progress.
If something has not been implemented, say so clearly.
Do not dump the entire repository into one response.
Work in phases.
PHASE 1:
Architecture + repository initialization.
PHASE 2:
Core engine + database.
PHASE 3:
Checkpointing + idempotency + retries.
PHASE 4:
Connectors.
PHASE 5:
CLI + API.
PHASE 6:
Observability + recovery.
PHASE 7:
Testing + security.
PHASE 8:
Documentation + CI/CD + release preparation.
After each phase:
explain what was implemented
identify files changed
identify tests added
identify remaining risks
identify the next phase
Do not move forward with major architectural changes without explaining why.
The final result should look like a project that a professional engineering team could realistically review and potentially use—not a portfolio toy.
