# Modular monolith

## Product definition

TAgent Core is the persistent execution kernel and governance control plane for one agent instance. It receives routed intent, creates a durable `TaskRun`, supervises bounded `Attempt`s, owns authoritative state and evidence, and delivers a result only after completion policy settles.

The system deploys as one Core process but is developed as an acyclic npm-workspaces graph. This keeps transactions and lifecycle coordination local while giving each domain a production boundary and public interface.

## Workspace map

| Kind | Workspace | Owns |
| --- | --- | --- |
| Contract | `@tagent/abi` | v1 schemas, codecs, shared primitives, fixtures |
| Client | `@tagent/core-client` | typed HTTP, SSE, acknowledgements, transport errors |
| Domain | `@tagent/governance` | capability, approval, policy, Workspace Goal, canonical authority |
| Domain | `@tagent/execution` | `TaskRun`, `Attempt`, request envelopes, event vocabulary, ToolRegistry/Pipeline, settlement, continuation, recovery |
| Domain | `@tagent/admission` | sessions, submissions, inbox admission and scheduling |
| Domain | `@tagent/memory` | recall, capture, lifecycle, Hot/Warm/Cold storage ports |
| Domain | `@tagent/learning` | observations, projections, workflow evolution and authority |
| Adapter | `@tagent/http-fastify` | `/api/v1`, auth, CORS, media protocols |
| Adapter | `@tagent/persistence-sqlite` | current schema, repositories, UOW, writer fence |
| Adapter | `@tagent/runtime-pi` | `pi-agent-core.AgentHarness` session policy and `pi-ai` provider normalization |
| Adapter | `@tagent/workspace-local` | Tool Providers, contained filesystem tools, managed subprocesses |
| App | `@tagent/core-service` | configuration, composition, startup, recovery, shutdown |
| App | `@tagent/web-console` | independent browser operator interface |

The repository root contains build and release orchestration plus the `src/server.ts` CLI shim. It is not a second domain layer.

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

`@tagent/core-service` is the Core composition root. It acquires the SQLite instance lock and writer authority, creates repositories and domain services, registers the Fastify adapter, coordinates recovery and background workers, listens, and owns ordered shutdown.

The system remains a modular monolith: Core domains, adapters, and background workers run in one process. Boundaries are TypeScript/package interfaces and durable contracts, not network calls. A later process split can replace a port implementation without moving domain authority into transport code.

Tools follow the same composition rule. Workspace-local providers describe schemas and effects, Execution's registry produces one immutable Attempt catalog, and Execution's pipeline applies authorization, receipts and settlement before provider code can run. Pi sees only the wrapped runtime-neutral catalog. Process creation is behind `SubprocessPort`, while credential values are behind `CredentialResolverPort`; neither host concern leaks into tool domain contracts or durable configuration.

## Core and Web separation

Core serves only `/api/v1`. It does not serve `index.html`, static Web assets, or an SPA fallback. The Web Console builds as a separate Vite artifact, uses the Core client, and may be hosted on another origin behind a Gateway.

This separation prepares multiple future channels to use the same stable ABI and Core client without importing Web implementation or domain internals.

## Durable write boundary

All control-plane writes pass through the active SQLite writer fence. Multi-repository changes execute inside a synchronous Unit of Work so state, receipts, and events commit atomically. Background code consumes owned ports and cannot escape the transaction with an async callback.

See [PERSISTENCE_AND_RECOVERY.md](PERSISTENCE_AND_RECOVERY.md) for the lifecycle and recovery contract.
