# TAgent Core documentation

This directory contains the maintained contracts for the current TAgent Core main line. Git history and release tags retain superseded design notes and point-release evidence; files not listed here are not current contracts.

## Start here

- [Project overview](../README.md)
- [Security policy](../SECURITY.md)
- [Contributing](../CONTRIBUTING.md)

## Product and architecture

- [Modular monolith](MODULAR_MONOLITH.md) — workspace map, dependency direction, composition roots, and Core/Web separation.
- [Naming conventions](NAMING_CONVENTIONS.md) — canonical domain and wire terminology.
- [Workspace Goals](WORKSPACE_GOALS.md) — Workspace direction, user-approved Goal Roadmaps, guided TaskRuns, verified evidence, and explicit closure.
- [Skills center](SKILLS.md) — shared upload/edit/delete lifecycle, per-Workspace references, multi-Skill TaskRun snapshots, native Pi execution, and security limits.
- [Runtime](RUNTIME.md) — Core-managed Skill snapshots, explicit Pi Skill execution, cancellation ownership, provider recovery, compaction, and bounded durable-history recall.

## ABI and HTTP

- [API v1](API_V1.md) — route surfaces, envelopes, authentication, idempotency, structured tool failures, SSE, and strict versioned routing.
- [Operator Read API](OPERATOR_READ_API.md) — Gateway discovery, Session/TaskRun inventory, stable cursor semantics, scopes, and responsibility boundary.
- [ABI versioning](ABI_VERSIONING.md) — package exports, `specVersion`, strict current-contract rules, and fixtures.

## Persistence and execution

- [Persistence and recovery](PERSISTENCE_AND_RECOVERY.md) — current SQLite schema, receipts, writer fencing, Unit of Work, Generation handoff, and crash recovery.
- [Gateway profile release tuple](GATEWAY_PROFILE_COMPATIBILITY.md) — exact Core/profile/SDK identity, feature negotiation, CI ownership, and rollout.
- [Runtime](RUNTIME.md) — in-process AgentHarness boundary, Pi dependency containment, `TaskRun`/`Attempt` execution, compaction, provider compatibility, timeouts, and tool authority.
- [Execution reliability and efficiency](EXECUTION_EFFICIENCY.md) — snapshot edits, Artifact spill, project context, batching, context projection, Bash repeat protection, and continuation stalls.
- [Supervisor](SUPERVISOR.md) — trusted Bash evidence, bounded LLM review, approvals, candidate delivery, and continuations.
- [TaskRun finalization](TASKRUN_FINALIZATION.md) — plan-key convergence, delivery ordering, fresh required checks, final gate audit, and blocked-Run recovery.

## Security, Web, and Gateway

- [Security boundaries](SECURITY_BOUNDARIES.md) — Core authentication, principals, resource scopes, workspace, and writer authority.
- [Web Console security](WEB_CONSOLE_SECURITY.md) — separate origin, CORS, OIDC hosting boundary, and browser storage.
- [Deployment and Gateway](DEPLOYMENT_AND_GATEWAY.md) — stable Host/Generation deployment, staging, activation, configuration, backup, and rollback.
- [Gateway handoff status](GATEWAY_HANDOFF_STATUS.md) — evidence-based P0/P1/P2 implementation and acceptance gaps against the Gateway team's handoff.
- [Gateway production readiness](GATEWAY_PRODUCTION_READINESS.md) — pre-deployment verification and probes.

## Memory

- [Memory](MEMORY.md) — optional PostgreSQL/Hot/Warm/Cold architecture, policy, operations, and admin surface.

## Release

- [Release checklist](RELEASE_CHECKLIST.md) — toolchain, tests, audits, current-schema checks, artifacts, and publication.
- [Changelog](../CHANGELOG.md) — release-level changes and deployment or breaking notices.
