# TAgent Core 0.1.8 Release Audit

## Scope

0.1.8 formally integrates Memory-dependent Learning, passive observation, Learning Events, Communication Profiles, durable Experience Distillation, governed Workflow evolution, trusted evaluation and guarded execution into the stable release.

## Dependency and autonomy boundary

- Schema 22 persists a singleton Learning feature state.
- Memory off forces Learning and automatic execution off.
- Learning off stops the Distillation Worker and disables every Learning API/runtime path.
- Automatic execution off retains passive observation, evidence capture, distillation and candidate evolution, while preventing Workflow recall, active application, activation and canary start.
- Automatic execution on only enables participation in execution paths. Every active action still requires a separate human approval and explicit execution receipt.
- The top Web bar exposes the effective state, Memory dependency and permanent approval boundary.

## Release content

- Communication Profiles and revisions.
- Learning Event, Outcome Label and Correction ledgers.
- Conservative Memory feedback attribution.
- Persistent Distillation Jobs with lease, fencing, checkpoint, retry and dead letter.
- Semantic experience grouping, step consistency, failure counterexamples, conflict detection and failure handling.
- Versioned Workflow registry, proposals, tombstones and rollback.
- Trusted evaluation receipts, stable canary assignment and automatic safety rollback.
- Learning Center governance, operations and approval visibility.

## Compatibility

- Package version: `0.1.8`.
- SQLite schema: `22`.
- Existing databases migrate transactionally. Back up SQLite WAL/SHM and Memory PostgreSQL/Cold data together first.
- Code downgrade requires restoring the matching pre-upgrade database backup.

## Release gates

- TypeScript Server/Web checks.
- ESLint with zero warnings.
- Full test suite.
- Production Web/server build.
- Production and full dependency audits at high severity.
- Immutable release artifact and manifest verification.
- 3220 restart with health, feature-state, passive-mode and approval-gate verification.
