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

Core, clients, and artifacts for a release must use the same validated ABI build.
