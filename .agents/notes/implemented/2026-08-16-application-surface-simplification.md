# Decision: Simplify application surfaces without distributing Core

Status: implemented
Kind: simplification

## Problem

The modular-monolith dependency graph is acyclic, but several internal surfaces add forwarding rather than isolation: a large Store plus a second binding facade, an eighty-method Core coordinator, a broad HTTP application port with `unknown` results, duplicated Channel/Console/Web TaskRun projections, a custom Web SSE client beside Core Client, and a single Web component owning most application state. Source-text UI assertions preserve these shapes without proving behavior.

## Decision

Keep one process, one SQLite transaction boundary, and the existing domain packages. Split SQLite repositories internally by aggregate while leaving connection/UOW ownership centralized. Replace the flat Core coordinator with grouped typed services and object-based composition. Give each HTTP route group a narrow typed application port. Make Core Client the first-party wire implementation and keep one explicit wire-to-view projection in Web.

Split Web state into testable run-stream, transcript, workspace, inbox, and presentation controllers, using reducers where state transitions span multiple fields. Replace source-string behavior assertions with DOM/hook/integration tests. Tighten public event payload types from `Record<string, unknown>` wherever an event crosses the stable ABI.

## Alternatives considered

**Split into network microservices.** Rejected because it weakens local transactions and multiplies lifecycle and deployment failure modes.

**Retain facades as architectural documentation.** Rejected where a facade only forwards methods or returns `unknown`; package boundaries, named grouped services, and precise ports document the architecture more reliably.

**Perform one mechanical mega-rewrite.** Rejected because correctness fixes and typed seams can be migrated incrementally with compatibility tests at each step.

## Verification

- Store no longer owns unrelated aggregate implementations in one class, while all mutations remain writer-fenced and transactional.
- Core composition uses an options object and grouped services; no giant pure-forwarding coordinator remains.
- HTTP route groups depend on narrow ports with precise result types.
- Web uses Core Client for Channel transport and no duplicate SSE parser.
- `App.tsx` delegates CoreClient stream transport, acknowledgement scheduling, transcript projection, workspace loading/preferences, and presentation panels to testable modules.
- UI behavior tests exercise rendering/interactions and no longer depend primarily on source substrings.

SQLite schema, Transcript, Skills, Semantic Learning, and Store-backed port binding responsibilities now live in separate internal modules while one Store connection and synchronous Unit of Work retain atomic ownership. `createCoreApplication` accepts one named options object. The 86-method forwarding class was replaced by a composition-time binding function over grouped services with an explicit public-method whitelist, missing-method validation, and collision rejection.

The HTTP Learning port reuses exact `LearningApplication` signatures instead of duplicating `unknown` returns. Web event delivery uses CoreClient's ABI-validated SSE implementation; the custom parser was deleted. Web workspace loading/preferences, transcript projection, acknowledgement scheduling, and presentation panels are separate modules. `App.tsx` no longer owns their implementations. The former `web-state` source-substring suite is now executable projection, scheduling, controller, state-rule, and server-render behavior coverage.

Stable high-volume internal event producers now require typed message, tool, provider, request-envelope, and transcript payload fields. Store and binding seams retain compatibility methods only as delegators while further aggregate extraction can proceed without changing consumers.

Final validation:

- `npm run check`, `npm run lint`, and `npm run build` pass with the grouped application/options-object composition and extracted repositories/controllers.
- `npm test` passes 1,083 tests across 109 test files; the five skipped tests are four separately provisioned PostgreSQL Memory cases and one external-LLM quality case.
- The production Web build succeeds with Core Client transport shared by the Console; the performance benchmark retains 60.7% context-character reduction and 83.3% TaskRun round-trip reduction.

## Consequences

Changing internal composition surfaces touches many tests and adapters even when runtime behavior is preserved. Incremental adapters must not become permanent duplicate authorities, and bundle size must be checked when Web adopts more of Core Client.
