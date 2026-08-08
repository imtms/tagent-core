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
- [Workspace Goals](WORKSPACE_GOALS.md) — lightweight long-term outcome, plan approval, TaskRun/evidence links, and explicit closure.

## ABI and HTTP

- [API v1](API_V1.md) — route surfaces, envelopes, authentication, idempotency, SSE, and removed routes.
- [ABI versioning](ABI_VERSIONING.md) — package exports, `specVersion`, compatibility rules, and fixtures.

## Persistence and execution

- [Persistence and recovery](PERSISTENCE_AND_RECOVERY.md) — SQLite ownership, schema 37, trusted receipts, writer fencing, Unit of Work, lifecycle, and restart recovery.
- [Runtime](RUNTIME.md) — in-process Pi boundary, `TaskRun`/`Attempt` execution, timeouts, and tool authority.
- [Execution reliability and efficiency](EXECUTION_EFFICIENCY.md) — snapshot edits, Artifact spill, project context, batching, context projection, Bash repeat protection, and continuation stalls.
- [Supervisor](SUPERVISOR.md) — trusted Bash evidence, bounded LLM review, approvals, candidate delivery, and continuations.

## Security, Web, and Gateway

- [Security boundaries](SECURITY_BOUNDARIES.md) — Core authentication, principals, resource scopes, workspace, and writer authority.
- [Web Console security](WEB_CONSOLE_SECURITY.md) — separate origin, CORS, OIDC hosting boundary, and browser storage.
- [Deployment and Gateway](DEPLOYMENT_AND_GATEWAY.md) — deployment order, artifacts, configuration, backup, and rollback.
- [Gateway production readiness](GATEWAY_PRODUCTION_READINESS.md) — pre-cutover verification and probes.

## Memory and Learning

- [Memory](MEMORY.md) — optional PostgreSQL/Hot/Warm/Cold architecture, policy, operations, and admin surface.
- [Learning](LEARNING.md) — dependency on Memory, passive/active modes, durable authority, and approval boundary.

## Release

- [Release checklist](RELEASE_CHECKLIST.md) — toolchain, tests, audits, artifacts, migrations, and publication.
- [Changelog](../CHANGELOG.md) — release-level changes and upgrade notices.
