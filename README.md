# TAgent Core

**TAgent Core is designed by TMs and developed with AI assistance.**

TAgent Core is a durable, self-hosted control plane for a single agent instance. It turns routed user intent into a persistent `TaskRun`, supervises bounded `Attempt`s, owns authoritative state, evidence, approvals, recovery, Memory, and Learning, and produces verifiable delivery results.

Version `0.3.0` adds lightweight Workspace Goals, snapshot-aware workspace mutation, durable large-output Artifacts, Core-owned project context and runtime-efficiency improvements on the established 0.2 modular boundary. Core remains API-only and TaskRun remains the only execution runtime.

## Supported boundary

The supported production profile is:

- one TAgent Core process and one SQLite control-plane database;
- one trusted tool workspace;
- Node.js `24.18.1` and npm `12+`;
- Linux x64 for the immutable Core production artifact;
- Core on a private upstream network, with a trusted Gateway for browser identity;
- optional PostgreSQL 17 with `vector` and `pg_trgm` plus Local Cold storage for Memory.

This release does not provide an operating-system sandbox for `bash`, built-in browser OIDC login or token refresh, public multi-tenant isolation, or multi-process SQLite writers. Read [SECURITY.md](SECURITY.md) before deployment.

## Architecture

The repository contains 13 workspaces in one acyclic dependency graph:

| Layer | Workspace | Responsibility |
| --- | --- | --- |
| Contract | `@tagent/abi` | Runtime-validated public, channel, console, admin, and internal v1 schemas |
| Client | `@tagent/core-client` | Typed Core HTTP/SSE client |
| Domain | `@tagent/governance` | Approval, capability, policy, and lightweight Workspace Goal authority |
| Domain | `@tagent/execution` | `TaskRun`, `Attempt`, continuation, settlement, and recovery coordination |
| Domain | `@tagent/admission` | Session input admission and inbox scheduling |
| Domain | `@tagent/memory` | Optional Hot/Warm/Cold long-term Memory |
| Domain | `@tagent/learning` | Optional governed Learning projections and workflows |
| Adapter | `@tagent/http-fastify` | API-only Fastify adapter for `/api/v1` |
| Adapter | `@tagent/persistence-sqlite` | Schema 35, repositories, migrations, writer fencing, and Unit of Work |
| Adapter | `@tagent/runtime-pi` | In-process Pi runtime integration |
| Adapter | `@tagent/workspace-local` | Workspace-contained tools and path enforcement |
| Application | `@tagent/core-service` | Core composition root and lifecycle |
| Application | `@tagent/web-console` | Independent React/Vite operator console |

The Web Console depends only on `@tagent/abi` and `@tagent/core-client`. Core never imports or serves the Web Console. See [docs/MODULAR_MONOLITH.md](docs/MODULAR_MONOLITH.md).

## Requirements

- Node.js `24.18.1`
- npm `12+`
- an OpenAI Chat Completions-compatible provider and API key
- a trusted workspace directory
- optional PostgreSQL 17 with `vector` and `pg_trgm` for persistent Memory

## Local development

```bash
cp .env.example .env
npm ci
npm run dev
```

Set `OPENAI_API_KEY` and `TAGENT_WORKSPACE` in `.env` before submitting work. Development endpoints are separate:

- Core API: <http://127.0.0.1:3100/api/v1/health>
- Web Console: <http://127.0.0.1:5173>

`npm run dev` builds the workspaces, then runs Core and the Vite development server together.

To build and run Core only:

```bash
npm run build
npm start
curl -fsS http://127.0.0.1:3100/api/v1/health
```

Port 3100 serves the Core API, not a Web page.

## API and authentication

All supported HTTP routes use `/api/v1`. Use `@tagent/abi` for wire schemas and `@tagent/core-client` for typed access. Every JSON success is `{ data, requestId }`; every JSON failure is `{ error: { code, message, requestId, retryable, details } }`.

Submission idempotency uses the `Idempotency-Key` request header:

```bash
curl -fsS -X POST http://127.0.0.1:3100/api/v1/sessions \
  -H 'Content-Type: application/json' \
  -d '{"title":"Local session"}'
```

When `TAGENT_SERVICE_CREDENTIALS` is empty, Core uses local-admin mode. Keep that mode bound to the default `127.0.0.1`. When credentials are configured, protected routes fail closed and require a scoped opaque Bearer credential.

Core does not validate browser OIDC/JWT tokens. In production, a Gateway validates browser identity, strips the browser token, and forwards a minimal Core service credential. Configure exact origins with `TAGENT_CORS_ALLOWED_ORIGINS`; a non-empty allowlist requires at least one service credential. See [docs/API_V1.md](docs/API_V1.md) and [docs/WEB_CONSOLE_SECURITY.md](docs/WEB_CONSOLE_SECURITY.md).

## Persistence and recovery

Core owns a schema 35 SQLite database. Startup acquires an OS instance lock, applies migrations, claims a writer lease and fence, installs connection-level mutation guards, performs guarded recovery, starts services and workers, then reports the writer ready.

Only the active fenced writer may mutate control-plane state. Multi-repository writes use a synchronous Unit of Work. Back up the SQLite database together with its WAL/SHM files before an upgrade. Binaries that only understand schema 34 cannot open schema 35; rollback requires the matching pre-upgrade database backup. See [docs/PERSISTENCE_AND_RECOVERY.md](docs/PERSISTENCE_AND_RECOVERY.md) and [docs/UPGRADING_TO_0.2.md](docs/UPGRADING_TO_0.2.md).

## Optional Memory and Learning

Memory and Learning are disabled by default. Learning has a hard dependency on Memory:

```text
Memory off => Learning off => automatic execution off
```

Passive Learning may run with automatic execution disabled. Enabling automatic execution participation never bypasses human approval, capability policy, or completion evidence. Manage these features through the `/api/v1/admin/*` surface. See [docs/MEMORY.md](docs/MEMORY.md) and [docs/LEARNING.md](docs/LEARNING.md).

## Build and release

The release builder creates separate checksum-manifested Core and Web Console archives. Core explicitly excludes Web assets. The tag-triggered release workflow uploads both archives and checksums as a 30-day Actions artifact and attaches them to the GitHub Release.

```bash
npm run lint
npm run check
npm test -- --run
npm run build
```

The immutable artifact build additionally requires Linux x64, Node.js `24.18.1`, Node ABI 137, and npm `12+`:

```bash
npm run release:build
```

See [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md).

## Documentation

- [Documentation index](docs/README.md)
- [Architecture](docs/MODULAR_MONOLITH.md)
- [API v1](docs/API_V1.md)
- [Workspace Goals](docs/WORKSPACE_GOALS.md)
- [Execution reliability and efficiency](docs/EXECUTION_EFFICIENCY.md)
- [Deployment and Gateway](docs/DEPLOYMENT_AND_GATEWAY.md)
- [Upgrade from 0.1.x](docs/UPGRADING_TO_0.2.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Authorship and license

TAgent Core was designed by TMs and developed with AI assistance under TMs's direction and review. AI assistance is a development method and does not replace human project ownership or release accountability.

Copyright (c) 2026 TMs and TAgent Core contributors. Licensed under the [MIT License](LICENSE).
