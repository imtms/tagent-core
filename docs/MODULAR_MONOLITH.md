# Modular monolith

## Product definition

TAgent Core is the persistent execution kernel and governance control plane for one agent instance. It receives routed intent, creates a durable `TaskRun`, supervises bounded `Attempt`s, owns authoritative state and evidence, and delivers a result only after completion policy settles.

The system deploys as one Core product and one service. A small stable Host process supervises one replaceable Generation process; the Generation is the modular monolith described below. This keeps transactions and lifecycle coordination local while allowing the application kernel to restart or change release without adding an updater service.

## Workspace map

| Kind | Workspace | Owns |
| --- | --- | --- |
| Contract | `@tagent/abi` | v1 schemas, codecs, shared primitives, fixtures |
| Client | `@tagent/core-client` | typed HTTP, SSE, acknowledgements, transport errors |
| Domain | `@tagent/governance` | capability, approval, policy, Workspace Goal, canonical authority |
| Domain | `@tagent/execution` | `TaskRun`, `Attempt`, request envelopes, event vocabulary, ToolRegistry/Pipeline, settlement, continuation, recovery |
| Domain | `@tagent/admission` | sessions, submissions, inbox admission and scheduling |
| Domain | `@tagent/memory` | recall, capture, lifecycle, Hot/Warm/Cold storage ports |
| Adapter | `@tagent/http-fastify` | `/api/v1`, auth, CORS, media protocols |
| Adapter | `@tagent/persistence-sqlite` | current schema, repositories, UOW, writer fence |
| Adapter | `@tagent/runtime-pi` | `pi-agent-core.AgentHarness` session policy and `pi-ai` provider normalization |
| Adapter | `@tagent/workspace-local` | Tool Providers, contained filesystem tools, managed subprocesses |
| App | `@tagent/core-service` | stable Host plus Generation configuration, composition, startup, recovery, shutdown |
| App | `@tagent/web-console` | independent browser operator interface |

The repository root contains build and release orchestration plus one thin system CLI shim: `src/host.ts` starts the stable supervision loop. The Generation child entry remains private inside `@tagent/core-service`; it is neither exported nor exposed as a package binary and refuses startup without Host-provided IPC. The root is not a second domain layer.

## Dependency direction

```text
@tagent/abi <- @tagent/core-client <- @tagent/web-console
     ^                 ^
     |                 |
domains <- application ports <- adapters <- @tagent/core-service
```

The exact graph is enforced by workspace manifests, package exports, ESLint boundaries, and architecture tests. The invariants are:

- domains do not import adapters;
- adapters implement owned ports rather than becoming domain authorities;
- cross-workspace imports use declared package exports, never another workspace's `src` or `dist` tree;
- only `@tagent/core-service` composes production domains and adapters;
- the Web Console depends only on `@tagent/abi`, `@tagent/core-client`, and UI libraries;
- Core never imports the Web Console.

## Composition and runtime

`@tagent/core-service` contains two deliberately unequal roots. `host.ts` depends only on Node operating-system/release APIs and the neutral `generation-protocol.ts`: verified immutable selection, strict versioned IPC, bounded restart, activation state, readiness, and rollback. Architecture tests reject imports from `@tagent/*`, application composition, persistence, or `server.ts`. `server.ts` is the Generation composition root: it acquires the SQLite instance lock and writer authority, creates repositories and domain services, registers Fastify, coordinates recovery and background workers, listens, and owns ordered shutdown.

Generation-side Host awareness is isolated in the optional `ManagedGenerationAdapter`. It contributes one receipt-backed tool provider through the generic Runtime extension seam and one lifecycle callback between quiescence and writer release. Execution, domain services, and `CoreApplicationPersistencePort` contain no Host type. Direct Generation bootstrap remains valid with no adapter.

The application remains a modular monolith: all Core domains, adapters, and background workers run in the single active Generation. Host/Generation IPC is a lifecycle boundary, not a domain API, and the Host never proxies HTTP. Boundaries inside the Generation are TypeScript/package interfaces and durable contracts, not network calls. A later persistence-provider replacement can implement the existing application ports without moving domain authority into the Host or transport code.

Only one Generation may own the listener and writer fence. During activation the old Generation first quiesces and releases authority; only then is a verified candidate started. The Host switches `current` only after candidate readiness and a bounded heartbeat stabilization period. This favors a small availability gap over shared sockets, overlapping database writers, live-heap patching, or another updater daemon.

Tools follow the same composition rule. Workspace-local providers describe schemas and effects, Execution's registry produces one immutable Attempt catalog, and Execution's pipeline applies authorization, receipts and settlement before provider code can run. Pi sees only the wrapped runtime-neutral catalog. Process creation is behind `SubprocessPort`, while credential values are behind `CredentialResolverPort`; neither host concern leaks into tool domain contracts or durable configuration.

## Core and Web separation

Core serves only `/api/v1`. It does not serve `index.html`, static Web assets, or an SPA fallback. The Web Console builds as a separate Vite artifact, uses the Core client, and may be hosted on another origin behind a Gateway.

This separation prepares multiple future channels to use the same stable ABI and Core client without importing Web implementation or domain internals.

## Durable write boundary

All control-plane writes pass through the active SQLite writer fence. Multi-repository changes execute inside a synchronous Unit of Work so state, receipts, and events commit atomically. Background code consumes owned ports and cannot escape the transaction with an async callback.

Each governed state has one mutation entrance. Runtime completion, blocking, and failure use the fenced TaskRun transition port; cancellation uses the Attempt repository. Session Inbox collection edits use the receipt-backed Session Inbox capability profile. SQLite keeps one connection and synchronous Unit of Work while schema migration, Transcript, Skills, and port bindings live in focused internal modules; the compatibility `Store` delegates to those repositories and publishes no parallel terminal shortcuts or unreceipted Inbox application facades.

Application ports expose consumer-owned capabilities, not the complete method inventory of a concrete Store. HTTP receives only its two TaskRun read projections; Execution, Admission, Skill, approval, Attempt, and Context Manifest bindings similarly include only methods used across their boundary. Store-level hydration and diagnostic queries may remain internal for aggregate construction or persistence tests, but they are not promoted into application contracts merely because SQLite can answer them.

Core application construction accepts one named options object. Internally, Admission, Execution, Governance, Workspace Goals, Memory, and Skills stay grouped; the flat HTTP-facing application ABI is bound once from an explicit method whitelist with missing-method and collision checks. Web uses CoreClient for ABI/SSE transport and keeps workspace loading/preferences, transcript projection, ACK scheduling, and presentation components outside the root component.

See [PERSISTENCE_AND_RECOVERY.md](PERSISTENCE_AND_RECOVERY.md) for the lifecycle and recovery contract.
