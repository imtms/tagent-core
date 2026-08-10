# TAgent Core documentation

This directory contains the maintained contracts for the current TAgent Core main line. Git history and release tags retain superseded design notes and point-release evidence; files not listed here are not current contracts.

## Start here

- [Project overview](../README.md)
- [Upgrade and rollback](UPGRADING.md)
- [Security policy](../SECURITY.md)
- [Contributing](../CONTRIBUTING.md)

## Product and architecture

- [Modular monolith](MODULAR_MONOLITH.md) — workspace map, dependency direction, composition roots, and Core/Web separation.
- [Naming conventions](NAMING_CONVENTIONS.md) — canonical domain and wire terminology.
- [Workspace Goals](WORKSPACE_GOALS.md) — Workspace direction, user-approved Goal Roadmaps, guided TaskRuns, verified evidence, and explicit closure.

## ABI and HTTP

- [API v1](API_V1.md) — route surfaces, envelopes, authentication, idempotency, SSE, and removed routes.
- [Operator Read API](OPERATOR_READ_API.md) — Gateway discovery, Session/TaskRun inventory, stable cursor semantics, scopes, and responsibility boundary.
- [ABI versioning](ABI_VERSIONING.md) — package exports, `specVersion`, compatibility rules, and fixtures.

## Persistence and execution

- [Persistence and recovery](PERSISTENCE_AND_RECOVERY.md) — SQLite ownership, schema 41, Gateway/trusted receipts, writer fencing, Unit of Work, lifecycle, and restart recovery.
- [Runtime](RUNTIME.md) — in-process AgentHarness boundary, Pi dependency containment, `TaskRun`/`Attempt` execution, compaction, provider compatibility, timeouts, and tool authority.
- [Execution reliability and efficiency](EXECUTION_EFFICIENCY.md) — snapshot edits, Artifact spill, project context, batching, context projection, Bash repeat protection, and continuation stalls.
- [Supervisor](SUPERVISOR.md) — trusted Bash evidence, bounded LLM review, approvals, candidate delivery, and continuations.

## Security, Web, and Gateway

- [Security boundaries](SECURITY_BOUNDARIES.md) — Core authentication, principals, resource scopes, workspace, and writer authority.
- [Web Console security](WEB_CONSOLE_SECURITY.md) — separate origin, CORS, OIDC hosting boundary, and browser storage.
- [Deployment and Gateway](DEPLOYMENT_AND_GATEWAY.md) — deployment order, artifacts, configuration, backup, and rollback.
- [Gateway handoff status](GATEWAY_HANDOFF_STATUS.md) — evidence-based P0/P1/P2 implementation and acceptance gaps against the Gateway team's handoff.
- [Gateway production readiness](GATEWAY_PRODUCTION_READINESS.md) — pre-cutover verification and probes.

## Memory and Learning

- [Memory](MEMORY.md) — optional PostgreSQL/Hot/Warm/Cold architecture, policy, operations, and admin surface.
- [Learning](LEARNING.md) — dependency on Memory, passive/active modes, durable authority, and approval boundary.

## Release

- [Release checklist](RELEASE_CHECKLIST.md) — toolchain, tests, audits, artifacts, migrations, and publication.
- [Changelog](../CHANGELOG.md) — release-level changes and upgrade notices.
