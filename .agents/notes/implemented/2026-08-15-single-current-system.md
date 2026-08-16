# Decision: Collapse Core to one current system

Status: implemented
Kind: simplification

The later evolvable-current-state decision supersedes only this decision's fresh-only/no-migration consequence. One current API and one authority per mutation remain in force; exact legacy 0.8 SQLite state now migrates monotonically to revision 2.

## Problem

Core is a new system with no deployed compatibility obligation, but the repository retained historical HTTP and DTO aliases, aggregate compatibility clients, schema-30-through-47 migrations, legacy/canonical dual authorities, Learning dual-write and shadow cutover machinery, and tests and runbooks whose only purpose was upgrading or rolling back older builds. Those paths enlarged the security and recovery surface, obscured the current authority, and made a fresh database execute historical transformations before it could start.

## Decision

Treat the current public feature set as the only supported application system. Core 0.8 keeps the `tagent-core/0.8` identity, reports public schema revision `2`, creates through the ordered migration runner, and upgrades only the exact legacy revision-1/pre-`user_version` 0.8 shape. It rejects unmarked, differently identified, newer, journal-mismatched, or structurally drifted databases instead of ad-hoc repair.

Persistent Memory initializes only an absent PostgreSQL `memory` schema, records `tagent-memory/0.8` with schema version `1`, and rejects an existing unmarked or differently identified schema. Its current schema is expressed directly without column-upgrade statements.

Publish one strict current API and SDK. Workflow lifecycle, approved proposal, canary, and feature-policy effects use the Workflow Governance repository. Runtime completion, blocking, and failure use the fenced TaskRun transition repository, while cancellation uses the Attempt repository. Learning stores observations, proposals, approval preparation, application receipts, and feedback without retaining shadow Governance mutations; binding mode changes only with an application receipt. Session Inbox collection mutations use the receipt-backed capability-profile path without a parallel application facade. Learning delivery uses `integration_outbox` with the single `learning-projection-v1` consumer. Historical migrations, compatibility fields and decoders, aggregate client helpers, authority switches, dual writes, shadow comparison, reconciliation, cutover, tests-only terminal shortcuts, and upgrade-only recovery paths are not part of the maintained system.

Preserve the current Session, TaskRun, Gateway profile, Skills, Memory, Learning, Workflow, Autonomy, Web, idempotency, recovery, authorization, redaction, pagination, cancellation, and release capabilities. Current implementations use responsibility-based names rather than migration-era `legacy` or `canonical` names.

## Alternatives considered

- Keeping migrations while deleting only old tests was rejected because fresh startup would still execute and maintain every historical path.
- Retaining inactive shadow authorities or convenience mutation facades as future safety mechanisms was rejected because they create multiple possible sources of truth and let tests or in-process callers bypass production fencing and receipts.
- Resetting the repository to a smaller feature subset was rejected because simplification must preserve the current user-visible and operational feature set.

## Verification

- `npm run check` passed all decision-record, workspace build, server typecheck, test typecheck, and Web typecheck gates.
- `npm run lint` passed with zero warnings.
- `npm test` passed 107 test files with 1 environment-gated PostgreSQL file skipped: 1,032 tests passed and 4 skipped. This includes fresh-schema creation and drift rejection, repository authority, recovery, Gateway provider/readiness, architecture, release, SDK, Web, and runtime coverage.
- `npm run build` produced the production Core and Web builds.
- `npx --yes knip@latest --reporter compact` reported no unused files, dependencies, or exports after the obsolete surfaces were removed.
- `npm run release:sdk -- <temporary-directory>` produced and smoke-tested the ABI and Core Client 0.8.4 tarballs and portable SHA-256 files.
- Production-only and complete-tree `npm audit` runs at the high threshold both reported zero vulnerabilities.
- `npm run benchmark:compaction` passed its deterministic bounded-recall thresholds.
- `git diff --check` passed, and repository searches found no maintained previous-release version reference, numbered migration schema, dual-authority symbol, or old-table negative assertion.
- Architecture searches and tests confirm that production code exposes no direct TaskRun terminal shortcut, Learning settings writer, Workflow Learning governance mutation shadow, standalone binding-mode setter, or non-profile Session Inbox collection facade. Tests drive terminal fixtures through the same TaskRun/Attempt authority as production.

The immutable Core/Web archive build requires Linux x64, Node 24.18.1, and ABI 137 by construction. The tag-triggered release workflow is the authoritative environment for that platform-specific gate.

## Consequences

Core has one current schema and one authority per durable operation, reducing its code, recovery, security, and test surface. Application ports describe only mounted behavior, and tests no longer force production storage to retain bypass helpers. Schema changes advance an ordered migration history without restoring historical application authorities or compatibility APIs.

Existing exact 0.8 revision-1 databases are supported migration inputs; other historical databases and older Gateway, ABI, or Core Client tuples remain unsupported. Marker/journal edits and row copying are unsupported. Rollback requires a binary declaring the current r2 state protocol or restoration of the matching pre-upgrade backup.
