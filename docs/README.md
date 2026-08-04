# Documentation index

This index distinguishes maintained contracts from historical design and release evidence. Documentation not listed here should not be treated as a current interface or operational contract.

## Current product and architecture

- [Development status](STATUS.md) — current implemented capabilities, schema level, and known limitations.
- [Roadmap to 0.2.0](ROADMAP_0.2.md) — incomplete architecture milestones; not a delivery promise.
- [Runtime architecture](RUNTIME.md) — TaskRun execution and runtime ownership.
- [Pi runtime boundary](PI_RUNTIME_BOUNDARY.md) — responsibilities retained by Core versus the Pi runtime.
- [Supervisor](SUPERVISOR.md) — supervision model and completion governance.
- [Automation API contract](core-api-contract.md) — current scoped automation API boundary.
- [Spawn Proposal migration](SPAWN_PROPOSAL_MIGRATION.md) — Schema 27 migration from the removed Spawn Proposal subsystem.

## Memory and Learning

- [Long-term memory overview](MEMORY.md)
- [Memory architecture](MEMORY_ARCHITECTURE.md)
- [Memory operations](MEMORY_OPERATIONS.md)
- [Memory API and UI](MEMORY_API.md)
- [Memory release checklist](MEMORY_RELEASE_CHECKLIST.md)
- [Memory design baseline](MEMORY_DESIGN_PLAN.md) — historical design context; current behavior is defined by the architecture and operations documents.
- [Memory-dependent Learning](LEARNING.md)
- [Learning release coverage](LEARNING_RELEASE_COVERAGE.md)
- [Semantic Memory/Learning evaluation](SEMANTIC_MEMORY_LEARNING_EVALUATION.md)

## Deployment and release

- [Production deployment](PRODUCTION_DEPLOYMENT.md)
- [Release checklist](RELEASE_CHECKLIST.md)
- [0.1.13 release audit](RELEASE_AUDIT_0.1.13.md) — latest retained release audit.
- [Memory/Learning release audit](LEARNING_RELEASE_AUDIT.md) — retained subsystem evidence referenced by the release checklist.

Older point-release and one-off PR audit reports were removed from the maintained tree. They remain available through Git history and tags, while [CHANGELOG.md](../CHANGELOG.md) provides the release-level history.
