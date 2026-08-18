# TAgent Core

**TAgent Core is designed by TMs and developed with AI assistance.**

TAgent Core is a durable, self-hosted control plane for a single agent instance. It turns routed user intent into a persistent `TaskRun`, supervises bounded `Attempt`s, owns authoritative state, evidence, approvals, recovery, and optional Memory, and produces verifiable delivery results.

The current 0.8 release is one monotonic-state Core system with independently negotiated Gateway capability profiles for Session Settings, Inbox, Context Manifest, Skills, and Memory. Profile mutations replay immutable stored responses before mutable validation or side effects, and snapshot lists use stable storage-backed pagination without a 500-member ceiling. Core retains managed Skills, governed Workspace Goals, trusted execution receipts, optional Memory, the contained `pi-agent-core` runtime, and receipt-backed self-restart/handoff. Core remains API-only and `TaskRun` remains the only execution runtime.

## Supported boundary

The supported production profile is:

- one TAgent Core service with one stable Host, at most one active Generation, and one SQLite control-plane writer;
- one trusted tool workspace;
- Node.js `24.18.1` and npm `12+`;
- Linux x64 for the immutable Core production artifact;
- Core on a private upstream network, with a trusted Gateway for browser identity;
- optional PostgreSQL 17 with `vector` and `pg_trgm` plus Local Cold storage for Memory.

This release does not provide an operating-system sandbox for `bash`, built-in browser OIDC login or token refresh, public multi-tenant isolation, or multi-process SQLite writers. Read [SECURITY.md](SECURITY.md) before deployment.

## Architecture

The repository contains 12 workspaces in one acyclic dependency graph:

| Layer | Workspace | Responsibility |
| --- | --- | --- |
| Contract | `@tagent/abi` | Runtime-validated public, channel, console, admin, and internal v1 schemas |
| Client | `@tagent/core-client` | Typed Core HTTP/SSE client |
| Domain | `@tagent/governance` | Approval, capability, policy, and lightweight Workspace Goal authority |
| Domain | `@tagent/execution` | `TaskRun`, `Attempt`, continuation, settlement, and recovery coordination |
| Domain | `@tagent/admission` | Session input admission and inbox scheduling |
| Domain | `@tagent/memory` | Optional Hot/Warm/Cold long-term Memory |
| Adapter | `@tagent/http-fastify` | API-only Fastify adapter for `/api/v1` |
| Adapter | `@tagent/persistence-sqlite` | Current schema, repositories, writer fencing, and Unit of Work |
| Adapter | `@tagent/runtime-pi` | In-process Pi runtime integration |
| Adapter | `@tagent/workspace-local` | Workspace-contained tools and path enforcement |
| Application | `@tagent/core-service` | Core composition root and lifecycle |
| Application | `@tagent/web-console` | Independent React/Vite operator console |

The Web Console depends only on `@tagent/abi` and `@tagent/core-client`. Core never imports or serves the Web Console. See [docs/MODULAR_MONOLITH.md](docs/MODULAR_MONOLITH.md).

## Requirements

- Node.js `24.18.1`
- npm `12+`
- macOS or Linux for local runtime development; package compilation and documentation checks remain cross-platform, but `@tagent/workspace-local` requires POSIX descriptor-relative filesystem APIs and fails early with `WORKSPACE_PLATFORM_UNSUPPORTED` on Windows
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

`npm run dev` builds the workspaces, then runs the Host-managed development Generation and the Vite development server together. The Generation child entry is internal and the immutable-release activation tool is intentionally absent in this mode.

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
  -H 'Idempotency-Key: local-session-001' \
  -d '{"title":"Local session"}'
```

When `TAGENT_SERVICE_CREDENTIALS` is empty, Core uses local-admin mode. Keep that mode bound to the default `127.0.0.1`. When credentials are configured, protected routes fail closed and require a scoped opaque Bearer credential.

Core does not validate browser OIDC/JWT tokens. In production, a Gateway validates browser identity, strips the browser token, and forwards a minimal Core service credential. The independent `operator.read.v1` profile provides authoritative Session/TaskRun inventory, and the capability-profile registry publishes five stable Gateway feature contracts without exposing private Store DTOs. Configure exact origins with `TAGENT_CORS_ALLOWED_ORIGINS`; a non-empty allowlist requires at least one service credential. See [docs/API_V1.md](docs/API_V1.md), [docs/OPERATOR_READ_API.md](docs/OPERATOR_READ_API.md), [docs/GATEWAY_PROFILE_COMPATIBILITY.md](docs/GATEWAY_PROFILE_COMPATIBILITY.md), and [docs/WEB_CONSOLE_SECURITY.md](docs/WEB_CONSOLE_SECURITY.md).

## Persistence and recovery

Core owns a monotonic SQLite database identified by `tagent-core/0.8` and exposed as schema revision `2`. Startup acquires an OS instance lock, transactionally creates or upgrades the exact legacy 0.8 shape, validates the append-only migration journal and complete current schema, claims a writer lease and fence, installs connection-level mutation guards, performs guarded recovery, starts services and workers, then reports the writer ready.

Only the active fenced Generation may mutate control-plane state. Multi-repository writes use a synchronous Unit of Work. Runtime/background shutdown is a quiescence barrier: Core retains the Store, writer lease, guard, and instance lock if owned work cannot prove settlement. The stable Host never opens the application database; it supervises a verified Generation, restarts unexpected exits with a durable bounded budget, and coordinates receipt-backed handoff and rollback. Safe automatic TaskRun continuation is allowed only when no effect is ambiguous. Exact revision-1 0.8 databases upgrade in place after backup; revision-2 releases declare `tagent-core/state-0.8-r2`, so the Host cannot roll the migrated database back to an incompatible r1 binary. See [docs/PERSISTENCE_AND_RECOVERY.md](docs/PERSISTENCE_AND_RECOVERY.md).

## Self-managed Generation replacement

Production exposes one system entrypoint: `dist/host.js`. The Host forks the unexported `node_modules/@tagent/core-service/dist/generation-entry.js` child selected by the immutable `current` link; that child refuses to boot without the Host marker and IPC channel, while package binaries and development startup also enter through the Host. Every Generation keeps the stable release root as its working directory, so relative database and workspace paths do not move with immutable code releases. Deployment only stages and verifies a release; an explicitly approved `core_generation_activate` call restarts `current` or activates a staged 40-character commit after its operation receipt is durable.

The old Generation stops HTTP, joins owned work, stores a Continuation handoff, and releases its writer fence before the candidate starts. `current` changes only after candidate readiness. Candidate failure restores the previous compatible release, while a Generation crash restarts the committed release and resumes only provably safe interrupted TaskRuns. Host changes themselves still require a normal service restart. See [docs/DEPLOYMENT_AND_GATEWAY.md](docs/DEPLOYMENT_AND_GATEWAY.md).

## Completion evidence and model calls

A passed required check is trusted only when Core binds it to a successful `tool.bash` operation from the current Attempt. Core derives the command, exit code, output projection, completion time, digest and Artifact reference from the operation receipt; Agent-authored evidence text is not proof. Change, verification and release work requires at least one such trusted required check, after which the Supervisor performs one semantic review against the actual receipts and acceptance criteria.

Deterministic prerequisite failures and exact literal deliveries do not call the Supervisor LLM. Translation, rewriting, summarization, drafting, prose review and ordinary answers use one compact semantic judge; mutation and high-impact work use one full evidence review. Malformed output is repaired or rejected locally without a second model call, and retryable transport failure is retried only against a separately hosted fallback. See [docs/SUPERVISOR.md](docs/SUPERVISOR.md) and [docs/EXECUTION_EFFICIENCY.md](docs/EXECUTION_EFFICIENCY.md).

## Workspace Skills

The Web Console provides one Skills center shared across Workspaces. Upload or drop a `SKILL.md`/ZIP once, edit it through immutable revisions, delete it from the catalog, and select any number of entries for each Workspace. Core freezes the latest revision of every reference into each newly admitted `TaskRun`; later edits, reference changes, or deletion never alter running work or its continuations.

Execution uses the native Pi Skill path: `@tagent/runtime-pi` registers every frozen projection in `AgentHarness.resources.skills`; a one-Skill Workspace retains explicit `AgentHarness.skill()` invocation, while Pi selects among a multi-Skill set by its native matching behavior. Core does not flatten Skills into the system prompt, and a Skill cannot add tools or bypass approvals, receipts, path containment, or settlement policy. See [docs/SKILLS.md](docs/SKILLS.md).

## Optional Memory

Long-term Memory is disabled by default and can be enabled independently through `TAGENT_MEMORY_*` configuration and the `/api/v1/admin/*` surface. See [docs/MEMORY.md](docs/MEMORY.md).

The retired Learning implementation is preserved in the `learning-archive` branch. `main` contains no Learning runtime, APIs, Web UI, configuration, or installable workspace. Legacy SQLite Learning tables remain inert in the immutable schema baseline so upgrades preserve existing data without silently deleting it.

## Build and release

The release builder creates separate checksum-manifested Core and Web Console archives plus installable ABI and Core Client SDK tarballs. Core explicitly excludes Web assets. The tag-triggered release workflow uploads all four artifacts and their checksums as one 30-day Actions artifact and attaches all eight files to the GitHub Release.

```bash
npm run lint
npm run check
npm test -- --run
npm run build
npm run benchmark:compaction
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
- [Workspace Skills](docs/SKILLS.md)
- [Execution reliability and efficiency](docs/EXECUTION_EFFICIENCY.md)
- [Deployment and Gateway](docs/DEPLOYMENT_AND_GATEWAY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Authorship and license

TAgent Core was designed by TMs and developed with AI assistance under TMs's direction and review. AI assistance is a development method and does not replace human project ownership or release accountability.

Copyright (c) 2026 TMs and TAgent Core contributors. Licensed under the [MIT License](LICENSE).
