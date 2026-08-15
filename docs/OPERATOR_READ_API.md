# Operator Read API

## Purpose and ownership

`operator.read.v1` is the stable cross-team read profile for discovering Core-owned Sessions and their complete TaskRun history. The supported path is:

```text
Browser -> Gateway (OIDC, ACL, audit, projection) -> Core Operator Read API (authority)
```

Core owns the authoritative data, runtime-validated ABI, bounded queries, pagination semantics and service-principal scope checks. Gateway owns browser identity, actor-to-resource authorization, northbound REST/WebSocket DTOs, its rebuildable projection, Fake Core implementation and exact-release integration jobs. Gateway must not read Core SQLite, Workspace files, private Store APIs or `/api/v1/console/*` DTOs.

## Discovery and release identity

`GET /api/v1/capabilities` advertises `operator.read.v1` in `apiVersions`. Endpoint IDs remain in the independently owned `operator.profileVersion=1.0` document so base discovery and Operator Read evolve as separate current contracts.

After discovering the API version, call `GET /api/v1/operator/capabilities`. Its independent `profileVersion=1.0` contract publishes the exact endpoint IDs, orders, cursor guarantees, retention behavior and limits. A Gateway may enable historical discovery only after both checks succeed; failure must not disable unrelated Channel features.

The profile endpoint IDs are:

```text
operator.read.capabilities.get
operator.sessions.list
operator.sessions.task_runs.list
operator.sessions.task_runs.latest
```

The ABI is exported from `@tagent/abi/operator/read-v1`; all methods are also available on `CoreClient`.

## Routes and scopes

| Route | Required Core service scopes | Result |
| --- | --- | --- |
| `GET /api/v1/operator/capabilities` | `sessions:read` | Operator Read capability profile |
| `GET /api/v1/operator/sessions?cursor=&limit=` | `sessions:read` | bounded Session summaries |
| `GET /api/v1/operator/sessions/{sessionId}/task-runs?cursor=&limit=` | `sessions:read` and `runs:read` | complete persisted TaskRun summaries for the Session |
| `GET /api/v1/operator/sessions/{sessionId}/task-runs/latest` | `sessions:read` and `runs:read` | latest TaskRun summary, or `data: null` for an empty Session |

Missing or invalid credentials return `401 auth.unauthenticated`; missing scopes return `403 auth.permission_denied`. A missing Session returns `404 session.not_found`. Invalid, malformed or resource-mismatched cursors return `400 pagination.cursor_invalid`; an invalid limit returns `400 pagination.limit_invalid`.

Defaults are 50 items and maxima are 200 for both lists. `goalSummary` and `blockedReason` are deterministically bounded to 500 characters. Summary creation does not invoke an LLM and exposes neither the full contract nor source input, prompt, credential, Workspace path or tool payload.

## Pagination and consistency

Both lists use immutable `(createdAt DESC, id DESC)` keyset order. Using creation time instead of mutable update time keeps an item from moving across page boundaries while a scan is in progress. Latest TaskRun selection is deterministic by `(updatedAt DESC, id DESC)`.

The cursor is opaque, versioned and bound to endpoint kind, resource, filter set and snapshot membership. The first page captures a persisted SQLite row-membership boundary. Concurrent inserts are excluded from that cursor chain; tied timestamps do not create duplicates or omissions; retrying a cursor repeats the same position.

Membership is snapshot-consistent, while summary values are read-committed: an item admitted to the snapshot can expose a newer title, status or latest activity on a later page. This is intentionally not a database-wide historical value snapshot.

Cursors do not expire and survive a normal Core restart against the same exact current database/profile. They are not portable across database restore, table rewrite, `VACUUM`, or another profile release. Consumers must restart from page one after such maintenance or after `pagination.cursor_invalid`. The `snapshot` value in `pageInfo` is an opaque diagnostic/membership token, not a general read API or an SSE sequence.

Current retention has no automatic deletion and no tombstones. Missing resources therefore use 404. A future expiry, deletion or tombstone policy requires an explicitly negotiated profile change; Core does not emit a synthetic `pagination.cursor_expired` while expiry is disabled.

## Read API and events

Use Operator Read for initial discovery, complete history and projection rebuild. Use the existing TaskRun detail, interaction, Transcript and Artifact APIs for drill-down, then the generation-fenced SSE protocol for incremental events. Gateway persists every event locally before ACK. A local projection remains disposable and must be recoverable from Core.

P0 intentionally excludes `updatedAfter`, status/search filters, bootstrap aggregation, batch get, tombstones and a global change feed. Core should add these only when measured scale or consistency requirements justify their contract and index cost. Core also does not implement Gateway OIDC, browser sessions, ACL storage, WebSocket delivery, northbound projection or a Gateway-owned fake server.

## Verification

Provider, ABI, Core Client and current-schema tests cover empty and missing Sessions, tied timestamps, concurrent inserts, cursor replay/mismatch/malformed input, restart continuation, scope failures, latest semantics, public-summary redaction and histories larger than the maximum page size. The current schema validates the ordered Session/TaskRun indexes as part of its exact shape.
