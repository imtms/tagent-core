# ABI versioning

## Package boundary

`@tagent/abi` owns every supported wire schema and runtime codec. Its public exports are:

```text
@tagent/abi
@tagent/abi/shared
@tagent/abi/channel/v1
@tagent/abi/channel/v1/fixtures
@tagent/abi/console/v1
@tagent/abi/admin/v1
@tagent/abi/internal/v1
@tagent/abi/operator/read-v1
```

Import only these declared exports. Deep imports from `src` or `dist` are not ABI.

## Version markers

HTTP paths carry the API major as `/api/v1`. Resources and events that cross durable asynchronous boundaries use `specVersion: "1.0"`. The package version identifies the repository release; it does not replace the wire major or resource `specVersion`.

## Compatibility rules

The following changes require a new major ABI or a named migration window:

- removing or renaming a route, field, literal, or event type;
- changing a required field, identifier meaning, status transition, idempotency rule, or authorization requirement;
- changing media framing, acknowledgement semantics, error envelope shape, or retry meaning;
- accepting a payload that an existing runtime decoder must reject, when that changes authority or safety.

The following may remain in v1 when consumers and fixtures are updated together:

- a new optional field with a safe default;
- a new error code within the existing envelope;
- a new route that does not change existing resource semantics;
- a new event type that old consumers may safely ignore by contract.

Do not keep indefinite compatibility namespaces in the primary ABI. A deprecation must name its successor, migration instructions, and removal release.

## Runtime validation

Fastify route handlers decode ingress and encode egress with `@tagent/abi`. `@tagent/core-client` decodes response envelopes and SSE frames and reports malformed wire data as a protocol error. Compile-time TypeScript types alone are not sufficient.

## Change procedure

1. Change the owned schema and exported type.
2. Update canonical fixtures and encode/decode tests.
3. Update Fastify request/response mapping.
4. Update `@tagent/core-client` and replay/ack behavior.
5. Update Web or other channel consumers.
6. Add differential coverage for removed or incompatible routes.
7. Update [API_V1.md](API_V1.md), [CHANGELOG.md](../CHANGELOG.md), and upgrade guidance.

Core, clients, and artifacts for a release must use the same validated ABI build. Core publishes the owned schemas, canonical fixtures, typed client and provider/consumer contract tests. Gateway owns its fake-Core process/container and the current/previous Gateway-client CI matrix; those components encode Gateway transport and release policy and are not Core runtime deliverables.

## Gateway contracts v39 migration window

Schema v39 introduces the named `gateway-contracts-v39` migration window. It intentionally tightens the pre-production Channel/Operator contract before Gateway ownership is enabled:

- `POST /api/v1/sessions` now requires `Idempotency-Key`;
- TaskRun adds `currentAttempt` and typed `pendingInteractions`;
- command receipts add `state`, `outcome`, `replayed`, and original `result`;
- Transcript responses add mandatory `pageInfo` and are server-paginated;
- event-consumer cursors add settled/final ACK fields;
- Workspace Goal writes require `requestId`.

Because v1 decoders reject unknown fields, a pre-v39 client is not wire-compatible with these tightened responses. `status: "duplicate"` and `terminalAcknowledgedSequence` remain deprecated aliases only for the named schema-39 migration window. New consumers must use `replayed` plus `state/outcome`, and `settledAcknowledgedSequence`/`finalAcknowledgedSequence`; the aliases are removed with the next public API major.

## Gateway operator v40 migration window

Schema v40 completes the Gateway-facing audit and discovery contract:

- Submission accepts channel-neutral `origin`, persists its first Core principal/canonical audit receipt, and returns `audit`;
- Artifact metadata uses bounded `after`/`limit` pages with mandatory `pageInfo`;
- capabilities publishes the exact Operator endpoint allowlist, active Approval authority, receipt-recovery protocol, no-pruning cursor policy, and read-size limits;
- the Workspace Goal Operator subset has ABI-owned write bodies and typed Core Client methods;
- every public event catalog member has a canonical producer-valid fixture.

Deploy schema-40 Core and the matching `@tagent/abi`/`@tagent/core-client` before enabling the v40 profile. Gateway must negotiate `persistenceSchemaVersion=40`, `operator.profileVersion=1.0`, the required endpoint IDs and receipt/retention capabilities. The stable allowlist—not every `/api/v1/console/*` route—is the compatibility promise.

| Core profile | Client profile | Support |
| --- | --- | --- |
| schema 40 / Operator 1.0 | matching v40 ABI and Core Client | Supported |
| schema 40 / Operator 1.0 | pre-v40 strict decoder | Unsupported; mandatory audit/page/capability fields changed in the named window |
| schema 39 / Gateway contracts v39 | matching v39 client | Historical migration window only |
| any | undeclared Console/Admin proxy | Unsupported cross-team dependency |

Gateway CI may support more client minors, but it cannot infer compatibility when capability negotiation or strict decoding fails.

The next public API major should remove the v39 compatibility aliases rather than extending that window indefinitely.

## Operator Read profile (introduced in schema 41)

Schema 41 introduces a separate `operator.read.v1` capability profile for Session inventory, per-Session TaskRun inventory and latest TaskRun. `GET /api/v1/capabilities` adds only the API-version marker; clients then decode `GET /api/v1/operator/capabilities` with the dedicated schema. This avoids adding unknown endpoint literals or fields to the strict, closed Operator 1.0 decoder introduced in v40.

The profile freezes bounded public summaries, dual-scope enforcement for nested TaskRun reads, immutable keyset order, cursor bindings, snapshot-membership/read-committed-value consistency and current no-expiry/no-deletion retention. Schema 42 retains this profile while adding the private Inbox execution-policy column. Schema 43 adds first-party Console Skill contracts; schema 44 extends them with shared catalog CRUD and multi-Skill Workspace references. Neither changes the Operator Read profile. The matching ABI export, fixtures, Core Client and provider must be deployed together.

| Core profile | Client behavior | Support |
| --- | --- | --- |
| schema 44 + `operator.read.v1` | negotiate current capabilities and use the matching 0.6.1 ABI/client | Supported current profile |
| schema 41 + `operator.read.v1` | negotiate API marker and dedicated capabilities, then use matching ABI/client | Supported |
| schema 41 + legacy Operator 1.0 decoder | unchanged legacy object still decodes; deployment policy must separately accept schema 41 | Wire-compatible only |
| schema 40 without `operator.read.v1` | Gateway disables only historical inventory/rebuild | Supported feature downgrade |
| any | depend on `/api/v1/console/*`, SQLite or private Store DTOs | Unsupported cross-team dependency |
