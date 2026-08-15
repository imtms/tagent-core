# Decision: Collapse Core to one current system

Status: implemented
Kind: simplification

## Problem

Core is a new system with no deployed compatibility obligation, but the repository retained historical HTTP and DTO aliases, aggregate compatibility clients, schema-30-through-47 migrations, legacy/canonical dual authorities, Learning dual-write and shadow cutover machinery, and tests and runbooks whose only purpose was upgrading or rolling back older builds. Those paths enlarged the security and recovery surface, obscured the current authority, and made a fresh database execute historical transformations before it could start.

## Decision

Treat a newly created database and the current public feature set as the only supported state. Core 0.8 creates and structurally validates the complete `tagent-core/0.8` SQLite schema directly and reports public schema version `1`. It rejects non-empty databases without that marker, different schema IDs, and any current-schema drift instead of upgrading or repairing them.

Publish one strict current API and SDK. Approval operations use the workflow-governance repository, Attempt state changes use the TaskRun transition repository, and Learning delivery uses `integration_outbox` with the single `learning-projection-v1` consumer. Historical migrations, compatibility fields and decoders, aggregate client helpers, authority switches, dual writes, shadow comparison, reconciliation, cutover, and upgrade-only recovery paths are not part of the maintained system.

Preserve the current Session, TaskRun, Gateway profile, Skills, Memory, Learning, Workflow, Autonomy, Web, idempotency, recovery, authorization, redaction, pagination, cancellation, and release capabilities. Current implementations use responsibility-based names rather than migration-era `legacy` or `canonical` names.

## Alternatives considered

- Keeping migrations while deleting only old tests was rejected because fresh startup would still execute and maintain every historical path.
- Retaining inactive shadow authorities as future safety mechanisms was rejected because they implement migration policy rather than current product behavior and create multiple possible sources of truth.
- Resetting the repository to a smaller feature subset was rejected because simplification must preserve the current user-visible and operational feature set.

## Verification

- `npm run check` passed all decision-record, workspace build, server typecheck, test typecheck, and Web typecheck gates.
- `npm run lint` passed with zero warnings.
- `npm test` passed 107 test files with 1 environment-gated PostgreSQL file skipped: 1,029 tests passed and 3 skipped. This includes fresh-schema creation and drift rejection, repository authority, recovery, Gateway provider/readiness, architecture, release, SDK, Web, and runtime coverage.
- `npm run build` produced the production Core and Web builds.
- `npm run release:sdk -- <temporary-directory>` produced and smoke-tested the ABI and Core Client 0.8.0 tarballs and portable SHA-256 files.
- Production-only and complete-tree `npm audit` runs at the high threshold both reported zero vulnerabilities.
- `npm run benchmark:compaction` passed its deterministic bounded-recall thresholds.
- `git diff --check` passed, and repository searches found no maintained 0.7.0 version reference or current schema-47/dual-authority symbol; the remaining old-table names are negative assertions that those tables do not exist.

The immutable Core/Web archive build requires Linux x64, Node 24.18.1, and ABI 137 by construction. The tag-triggered release workflow is the authoritative environment for that platform-specific gate.

## Consequences

Core has one startup schema and one authority per durable operation, reducing its code, recovery, security, and test surface. A schema change now updates the current schema definition and release identity directly; it does not add an upgrade migration.

Existing databases and older Gateway, ABI, or Core Client releases are unsupported. Operators must deploy matching 0.8 artifacts against a new empty database. Marker edits, row copying, in-place upgrades, and rollback to a binary that does not accept the exact 0.8 schema and contract tuple are not supported.
