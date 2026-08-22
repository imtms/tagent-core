# Gateway handoff status

This document records the Core team's responsibility decision for the Gateway handoff. Wire details live in [API_V1.md](API_V1.md), [OPERATOR_READ_API.md](OPERATOR_READ_API.md), and the capability profile documents returned by Core.

## Current baseline

| Item | Value |
| --- | --- |
| Review date | 2026-08-21 |
| Target release | `0.8.27` |
| SQLite schema | ID `tagent-core/0.8`, numeric version `2` |
| Channel API | `/api/v1` |
| Operator Read | `operator.read.v1` |
| Full-feature profiles | five profile `1.0` contracts |

## Decision

The Gateway requests are reasonable when they protect the REST/SSE/ABI boundary or expose Core-owned durable authority. Core therefore owns Session and TaskRun state, command and interaction receipts, event-consumer generations/ACKs, public inventory, capability discovery, and the five bounded feature profiles.

Browser identity, actor ACL policy, channel routing, local projections, persist-before-ACK storage, outbox, northbound delivery, and exact-tuple Gateway integration remain Gateway-owned. A passing Core probe cannot prove those behaviors.

## Core-ready contracts

| Area | Current contract |
| --- | --- |
| Session creation | Principal-scoped `Idempotency-Key`; canonical payload hash; Session and receipt commit atomically; exact replay or payload conflict. |
| Submission and provenance | Channel-neutral origin; authenticated Core principal and first provenance are persisted and returned without granting scope. |
| TaskRun commands | Receipt-first lookup, canonical hash, Attempt fencing, exact result/error replay, GET recovery, and explicit `outcome_unknown`. |
| Interactions | Typed Approval and User Input pending/history DTOs with bounded pages and idempotent resolution commands. |
| SSE | Typed public catalog, redacted internal diagnostics, bounded replay/buffer, generation fencing, durable ACK, settled/final watermarks. |
| Base capabilities | Release/schema/catalogs, endpoint IDs, ready Approval, receipt recovery, retention, and enforced limits. |
| Operator Read | Bounded Session inventory, complete per-Session TaskRun inventory, latest TaskRun, public redaction, dual-scope checks, stable cursors. |
| Workspace Goals | Create/revise/approve/generate/start/recover operations with canonical request identities and durable receipts. |
| Feature profiles | Session Settings, Inbox, Context Manifest, Skills, and Memory profile `1.0` summaries/details. Snapshot lists page on immutable membership/order keys and storage-backed `limit + 1` queries. |
| Profile persistence | Resource revisions, receipt-first exact replay with immutable response projections/ETags, durable operation receipts, audit identity separation, collection revisions, and restart uncertainty. |
| SDK evidence | Version-matched ABI/Core Client archives, canonical fixtures, and a real Core provider contract harness. |

Core exposes one TaskRun Approval contract with `ready=true`; Gateway does not choose an internal implementation.

## Recovery design

Core does not claim that an asynchronous runtime or provider effect shares one transaction with its HTTP response. The safety contract is:

1. persist the request claim before the effect;
2. execute through the owned fenced/atomic domain boundary;
3. settle a terminal public receipt only when the result is provable;
4. after interruption, return the original result or `outcome_unknown`;
5. never repeat an unknown effect under the same identity.

This gives Gateway deterministic reconciliation without pretending cross-service work is one SQLite transaction.

## Gateway-owned work

Gateway must implement and test:

- Fake Core and network-failure scenarios in Gateway CI;
- the exact current Core/ABI/Core Client tuple;
- browser OIDC/PKCE/session handling and removal of browser tokens before Core;
- channel SDK adapters, account registry, and peer/thread-to-Session routing;
- inbound deduplication, conversation binding, projection, outbox, and external delivery receipts;
- durable local persistence of every SSE event before Core ACK;
- Gateway WebSocket/northbound protocol and progress policy;
- actor-to-resource ACL evaluation and feature admission.

## Deferred by current policy

| Item | Decision |
| --- | --- |
| HTTP 410 / earliest-sequence recovery | Deferred while Core promises no event deletion or cursor expiry. |
| Global feed or Core WebSocket | Deferred until measured scale shows per-TaskRun SSE is insufficient. |
| More granular Approval/Artifact scopes | Deferred until they form an independently enforceable security domain. |
| Additional inventory filters/change feed | Deferred until inventory size and rebuild latency justify the extra cursor semantics. |
| Bootstrap, batch get, tombstones | Deferred; current retention has no deletion, expiry, or tombstone state. |

## Gateway admission baseline

Before traffic, Gateway must validate:

- schema version `2` and the required base command/event catalogs;
- the base Operator endpoint list and ready Approval contract;
- exact replay, durable receipt lookup, no blind replay, no pruning, and matching limits;
- complete cursor traversal beyond 500 members and stable snapshot membership when unread resources are updated;
- `operator.read.v1` and its dedicated capabilities when inventory is enabled;
- each enabled full-feature profile using the actual authenticated Gateway principal.

After an ambiguous response, Gateway queries the original receipt. `started` is in flight and `outcome_unknown` requires read-model reconciliation; neither permits blind replay. For SSE, Gateway persists `(taskRunId, consumerId, generation, sequence, eventId)` before ACK and reclaims a new generation after a stale-generation conflict.

## Evidence map

- ABI and fixtures: `packages/abi/src/channel/v1`, `packages/abi/src/operator`, `packages/abi/src/admin/profiles-v1`, `packages/abi/src/profiles/v1`
- Core Client: `packages/core-client/src/channel-v1-client.ts`, Operator/Admin profile clients, `capability-profile-client.ts`
- HTTP providers: `adapters/http-fastify/src/v1/*-profile-routes.ts`, Operator routes, capability profile routes
- persistence: `adapters/persistence-sqlite/src/current-schema.ts`, `sqlite/profile-contract-repository.ts`, `sqlite/sqlite-persistence.ts`
- release/readiness: `scripts/build-sdk-release.mjs`, `scripts/gateway-readiness-probe.mjs`, `.github/workflows/release.yml`
- automated evidence: ABI, Core Client, profile API/provider, persistence, readiness, and SDK release tests under `tests/`
