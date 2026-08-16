# ABI versioning

## Package boundary

`@tagent/abi` owns every supported wire schema and runtime codec. Its declared exports are:

```text
@tagent/abi
@tagent/abi/shared
@tagent/abi/channel/v1
@tagent/abi/channel/v1/fixtures
@tagent/abi/console/v1
@tagent/abi/admin/v1
@tagent/abi/admin/profiles-v1
@tagent/abi/internal/v1
@tagent/abi/operator/read-v1
@tagent/abi/operator/session-settings-v1
@tagent/abi/operator/inbox-v1
@tagent/abi/operator/context-manifest-v1
@tagent/abi/operator/skills-v1
@tagent/abi/profiles/v1
```

Deep imports from another workspace's `src` or `dist` tree are not ABI.

## Current release tuple

Core 0.8 publishes one coordinated contract tuple:

| Marker | Value |
| --- | --- |
| HTTP major | `/api/v1` |
| Durable resource/event version | `specVersion: "1.0"` where declared |
| SQLite schema ID | `tagent-core/0.8` |
| Public persistence schema version | `2` |
| Core state protocol | `tagent-core/state-0.8-r2` |
| Capability profile version | `1.0` |
| SDK package version | same as the Core release |

The package version identifies the release; it does not replace the HTTP major, resource version, or profile version. Core, Web, ABI SDK, and Core Client from different release tuples are unsupported unless Gateway proves and explicitly accepts that combination.

## Compatibility rules

The v1 decoders are strict. Breaking changes require a new major ABI or a new owning profile major. This includes:

- removing or renaming a route, field, literal, or event type;
- changing identifier meaning, status transitions, idempotency, receipt recovery, or authorization;
- changing media framing, ACK semantics, error-envelope shape, cursor identity, or retry meaning;
- changing an endpoint between exact replay and durable receipt lookup.

These changes may remain in v1 when schemas, fixtures, providers, and current consumers are updated together:

- a safe optional field;
- a new error code within the existing envelope;
- a new independent route;
- a new event type that consumers may safely ignore and ACK by contract.

The maintained ABI contains no alternate namespaces or deprecated response aliases. Removed clients and payload shapes are not accepted by the current release.

## Runtime validation

Fastify decodes ingress and encodes egress with `@tagent/abi`. `@tagent/core-client` decodes envelopes and SSE frames and reports malformed wire data as a protocol error. TypeScript types alone are not validation.

## Channel and Operator contracts

`GET /api/v1/capabilities` publishes the current release, schema version, command/event catalogs, typed interactions, base Operator endpoint IDs, Approval readiness, receipt recovery, retention, and enforced limits. Gateway must negotiate it before enabling Channel traffic.

`operator.read.v1` is negotiated independently through `GET /api/v1/operator/capabilities`. It freezes bounded public Session and TaskRun summaries, dual-scope enforcement, immutable keyset ordering, cursor bindings, snapshot membership, read-committed values, and no-expiry/no-deletion retention.

## Full-feature profiles

`GET /api/v1/capability-profiles` and its detail route publish five profile `1.0` identities:

- Session Settings;
- Session Inbox;
- Context Manifest;
- Skills;
- Memory;

Each detail owns its exact endpoint IDs, required scopes, resource authority, pagination, retention, compatibility, and recovery semantics. Adding an endpoint or optional field requires a profile minor and matching strict fixtures/client. Removing an endpoint, changing a scope/resource boundary, cursor/revision identity, or recovery kind requires a profile major.

Gateway may depend only on endpoint IDs returned by the owning profile. Undeclared Console/Admin routes are first-party Core/Web interfaces, not cross-team contracts.

## Change procedure

1. Change the owned schema and exported type.
2. Update canonical fixtures and encode/decode tests.
3. Update Fastify request/response mapping.
4. Update `@tagent/core-client`, including replay/ACK behavior.
5. Update Web or other current consumers.
6. Add current-contract route and rejection coverage.
7. Update `API_V1.md`, the release tuple, and `CHANGELOG.md`.
8. Build and smoke-test the matching ABI and Core Client SDK archives.

Core publishes the schemas, canonical fixtures, typed client, and real-provider contract harness. Gateway owns its Fake Core, network-fault scenarios, and the client-release matrix it promises to support. See [GATEWAY_PROFILE_COMPATIBILITY.md](GATEWAY_PROFILE_COMPATIBILITY.md).
