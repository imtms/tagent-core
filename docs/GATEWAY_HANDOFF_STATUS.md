# Gateway handoff status

This document records the Core team's responsibility decisions and evidence-based reviews of the Gateway implementation and Operator Read handoffs. It complements the wire contracts in [API_V1.md](API_V1.md) and [OPERATOR_READ_API.md](OPERATOR_READ_API.md); it does not move Gateway-owned behavior into Core.

## Review baseline

| Item | Reviewed value |
| --- | --- |
| Review date | 2026-08-13 |
| Main line at latest review start | `32dbf8159e7b260f2decdbf71e1ce9e3fbc00db2` |
| Core package version | `0.6.1` |
| SQLite schema | `44` |
| Latest Gateway handoff source baseline | Core checkout `62ce7199c5ae8b132efda11d4bcf343e9a527397` |

The Gateway documents mix Core contracts, Gateway implementation work, future scale features and internal Core migrations. This review accepts only requirements that protect the REST/SSE/ABI boundary or Core-owned durable authority. Session/TaskRun inventory is accepted because Core is authoritative; browser identity, ACLs, projection and northbound delivery remain Gateway-owned.

## Decision

The declared Channel, Workspace Goal Operator and Operator Read profiles satisfy the reasonable Core-owned Gateway requirements. Production use still requires the Core release gate and the Gateway repository's own release gate.

Core does not claim that one passing HTTP response proves end-to-end delivery. It guarantees durable identities, typed receipts/read models, generation-fenced replay, explicit uncertain outcomes and runtime capability negotiation. Gateway guarantees browser/channel identity, routing, local persistence before ACK, outbox/external delivery and its client compatibility matrix.

## Core Ready

| Handoff area | Core contract and evidence |
| --- | --- |
| P0-1 Session create idempotency | `Idempotency-Key` is principal-scoped; title/origin are canonicalized; Session and receipt commit atomically; replay precedes creation; changed payload is `session.idempotency_conflict`. API coverage includes 100 concurrent retries converging on one Session, persistent reopen/re-entry, ABI and Core Client tests. Schema-v39 re-entry validates every receipt column, constraint, foreign key and index fail-closed. |
| P0-2 command recovery | Commands have a principal/TaskRun/command identity, canonical hash, first-result/error replay, receipt-first lookup, GET recovery and Attempt fencing. Claims persist before effects. Interrupted unprovable effects become `outcome_unknown` and are never blindly replayed. `steer`/`follow_up` complete at the durable fenced inbox boundary; Runtime/provider delivery remains asynchronous by design. |
| P0-3 typed interactions | Approval and User Input have typed pending/history DTOs, bounded pages and idempotent TaskRun commands. Receipt replay/conflict and stale-Attempt checks use the common command protocol. `runs:read` and `runs:control` are sufficient; provenance is carried in the command audit. The typed read model is authoritative for lifecycle states without a dedicated public event. |
| P0-4 public SSE catalog | One canonical name (`task_run.waiting_input`), per-type producer schemas, one canonical fixture for every public catalog member, redacted `diagnostic.internal`, forward-compatible consumer decoding, bounded replay/live buffering, durable ACK, generation fencing and settled/final watermarks are implemented. |
| P0-5 Core contract kit | Core owns runtime schemas, typed client methods, canonical fixtures and provider/consumer tests for Session, Submission, commands, interactions, Transcript, Artifact, events, capabilities and Workspace Goals. Capability negotiation supplies release/schema/profile markers. |
| P1-1 Operator profile | `operator.profileVersion=1.0` and an exact endpoint-ID allowlist freeze only ABI-owned, Core-Client-backed endpoints with durable write identities. The stable subset includes the completed Channel surface and the full Workspace Goal create/revise/approve/generate/start/recover flow. Other Console/Admin routes are explicitly not Gateway contracts. |
| P1-2 Approval authority | Capabilities expose exactly one active authority and readiness. The current supported value is `legacy`, `ready=true`, `canonicalCutoverReady=false`. Gateway uses the typed interaction contract and does not depend on which private Core projection implements it. Requesting an unsupported canonical authority continues to fail closed. |
| P1-3 actor provenance | Session, Submission and command inputs use one channel-neutral provenance schema. Schema 40 persists Submission principal, canonical payload/hash and first provenance atomically with new admission. Submission/command receipts return the first `{ principalId, origin }` audit chain; provenance grants no scope and contains no channel SDK payload. |
| P1-4 capabilities | The endpoint publishes release, API/event/schema versions, command/event catalogs, typed interactions, Operator allowlist, Approval authority, receipt recovery, retention/cursor policy and enforced limits. The readiness probe fails fast on missing required capabilities. |
| P1-5 retention/cursors | Current policy is explicit: no automatic event deletion and no cursor expiry. Slow consumers are bounded and disconnected; reconnect starts from durable ACK. Stale generation and skip-ahead requests fail closed. |
| P1-6 bounded reads | Transcript, interactions and Artifact metadata are paginated with stable order, defaults, server maxima and typed page cursors. SSE reads/buffers and Artifact preview/download sizes are bounded. Compatibility aggregation methods remain available but Gateway should use page methods. |
| P2-1 trace fields | Public mapping fills correlation from request/command/submission/inbox/approval IDs and causation from owned decision/control identifiers when present. Missing Core event ancestry remains `null`; Core never fabricates a causation event ID. |
| P2-2 contract observability | The read-only probe reports consumer lag, settled/final unacknowledged counts and age, command/Goal `started` and `outcome_unknown` counts and oldest age, writer fence/readiness, migration issues, capabilities and authority. Young `started` work is observable but does not flap readiness; stale started work and every unknown outcome block it. |
| P2-3 scopes | Existing `runs:read`/`runs:control` match the current security domain. Cosmetic fine-grained scopes were not added. |
| Operator Read P0 | Independent `operator.read.v1` capability discovery, bounded Session inventory, complete per-Session TaskRun inventory and latest TaskRun are implemented with ABI schemas/fixtures, Core Client methods, public summaries, scope checks and the schema-41 indexes retained by schema 44. Immutable creation-order keysets preserve snapshot membership across ties and concurrent inserts; values are explicitly read-committed. The legacy strict Operator 1.0 allowlist is unchanged. |

## Accepted recovery design

The handoff proposes committing every local command effect, event and terminal HTTP receipt in one cross-service Unit of Work. That is not a truthful blanket contract for commands that can cross Runtime abort/delivery, provider compaction, resume preparation, scheduling or approval-triggered admission.

Core instead freezes the safety property Gateway needs:

1. persist the command claim first;
2. apply the domain effect through its owned fenced/atomic boundary;
3. settle the public receipt when the result is provable;
4. after interruption, return the original terminal receipt or `outcome_unknown`;
5. never repeat an unknown effect under the same identity.

This preserves no-blind-replay and explicit reconciliation without pretending asynchronous work is a SQLite transaction. Fully local domain transitions still commit their own state and event atomically. A future command-specific outbox may narrow unknown windows, but it is not required for safe Gateway integration.

## Gateway-owned

These items are required for an end-to-end product but must be implemented and tested in the Gateway repository:

- fake Core server/container and network-failure scenarios used by Gateway CI;
- current and previous supported Gateway-client compatibility jobs;
- browser OIDC/PKCE/session handling and browser-token removal;
- Telegram, Feishu, CLI and webhook adapters or SDK objects;
- Channel/account registry and peer/thread-to-Session routing;
- Gateway inbound dedup, conversation binding, projection, outbox and external delivery receipts;
- durable local persistence of an SSE event before Core ACK, replay deduplication and Gateway consumer ownership;
- Gateway WebSocket/northbound protocol and progress-message policy;
- Gateway actor-to-Session ACL evaluation and authorization catalog;
- Gateway projection rebuild orchestration and feature-specific admission when `operator.read.v1` is unavailable.

Core publishes schemas, fixtures, the typed client and a real provider test harness so Gateway can build those tests without copying private Core code.

## Deferred by policy

| Item | Decision |
| --- | --- |
| HTTP 410 / `earliestSequence` snapshot recovery | Deferred until Core introduces event pruning. Current capabilities promise no deletion and no cursor expiry, so a synthetic expiry protocol would have no executable state. |
| Global feed or Core WebSocket | Deferred until measured active-Run/SSE connection/reconnect data shows the per-TaskRun durable SSE model is insufficient. |
| Finer Approval/Artifact scopes | Deferred until those operations form an independently enforceable and auditable security domain. |
| Canonical Approval internal cutover | Not a Gateway blocker. Gateway negotiates the single currently ready authority; canonical cutover remains a Core-internal migration and cannot create dual effect authority. |
| Operator `updatedAfter`, status/search filters and change feed | Deferred until measured inventory size and rebuild latency justify mutable-order or watermark semantics. Current bounded full scan is complete. |
| Session bootstrap, batch get and tombstones | Deferred. Bootstrap requires a real atomic snapshot/watermark design; batch get is an optimization; current retention has no deletion, expiry or tombstone state to expose. |

## Non-blocking hardening

The following work can improve confidence without expanding the stable profile:

- add more process kill-point and sustained backlog/load cases beyond current restart, replay, concurrency, fence and migration tests;
- populate correlation/causation for additional internal producers only when a genuine durable predecessor ID exists;
- export the existing readiness counters through a metrics backend when production monitoring selects one;
- promote additional Console routes only after they gain ABI-owned DTOs, bounded reads, Core Client coverage and durable write identities.

None of these permits Gateway to depend on an undeclared endpoint today.

## Gateway integration baseline

Gateway may depend only on endpoint IDs returned by the owning capability profile. Before admitting base traffic it must require schema 44, the required command/event catalogs, legacy Operator profile 1.0, one ready Approval authority, exact-replay/no-blind-replay receipt semantics, no-pruning cursor policy and matching limits. Historical inventory additionally requires `operator.read.v1` in `apiVersions` and a compatible `GET /api/v1/operator/capabilities`; its absence disables only that feature.

After an ambiguous response, Gateway queries the original Submission, command or Goal receipt. `started` is in-flight, `outcome_unknown` requires read-model reconciliation, and neither is permission for blind replay. For SSE, Gateway persists the event under `(taskRunId, consumerId, generation, sequence, eventId)` before ACK and reclaims after stale generation.

## Evidence map

- ABI/catalog/fixtures: `packages/abi/src/channel/v1/*`, `packages/abi/src/console/v1/goal-schemas.ts`, `packages/abi/src/operator/read-v1/*`
- Core Client: `packages/core-client/src/channel-v1-client.ts`, `packages/core-client/src/console-goal-client.ts`, `packages/core-client/src/operator-read-v1-client.ts`
- HTTP providers: `adapters/http-fastify/src/v1/*`
- persistence: `adapters/persistence-sqlite/src/migrations/v39-gateway-contracts.ts`, `v40-gateway-operator.ts`, `v41-operator-read.ts`, `adapters/persistence-sqlite/src/store.ts`
- readiness: `scripts/gateway-readiness-probe.mjs`
- automated evidence: `tests/abi-contract.test.ts`, `tests/core-client.test.ts`, `tests/v1-api-differential.test.ts`, `tests/workspace-goals-api.test.ts`, `tests/operator-read-api.test.ts`, `tests/operator-read-v41-migration.test.ts`, `tests/gateway-contracts-v39-migration.test.ts`, `tests/gateway-operator-v40-migration.test.ts`, `tests/gateway-production-readiness.test.ts`
