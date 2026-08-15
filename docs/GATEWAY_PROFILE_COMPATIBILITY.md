# Gateway profile release tuple

This matrix is the release boundary for the full-feature Core/Gateway contract. It covers Core-owned wire and provider behavior only; Gateway still owns OIDC/ACL, inbound/outbox delivery, Fake Core and network-fault tests.

## Current release tuple

| Component | Required value |
| --- | --- |
| Core | `0.8.1` |
| SQLite | `tagent-core/0.8`, version `1` |
| Capability registry | `GET /api/v1/capability-profiles` |
| Profile versions | all eight profiles at `1.0` |
| ABI SDK | `@tagent/abi@0.8.1` |
| Typed client SDK | `@tagent/core-client@0.8.1` |
| Node.js | `>=24.18.1` for the SDK; Core release uses exactly `24.18.1` |

The eight profile identities are `operator.session-settings.v1`, `operator.session-inbox.v1`, `operator.context-manifest.v1`, `operator.skills.v1`, `admin.memory.v1`, `admin.learning.v1`, `admin.workflow.v1`, and `admin.autonomy.v1`.

## Supported tuple

| Core/provider | Gateway SDK | Result |
| --- | --- | --- |
| Core `0.8.1`, current schema, all required profile summaries/details available | ABI + Core Client `0.8.1` | Supported |
| Core `0.8.1`, current schema | hand-written DTOs or direct Console/Admin calls | Unsupported |
| Core `0.8.1`, required profile partially available/unavailable to the actual service principal | any | Unsupported for that profile until scopes/resource grants are corrected |
| Any other Core or SDK package version | any | Unsupported; deploy one matching release tuple |

Availability is negotiated per feature. A healthy Core or valid base `/api/v1/capabilities` response does not enable a missing full-feature profile. Gateway must validate the registry and the selected profile detail using the same authenticated service principal that will call its endpoints.

## Release assets

The GitHub Release attaches these SDK artifacts in addition to Core and Web Console archives:

```text
tagent-abi-0.8.1.tgz
tagent-abi-0.8.1.tgz.sha256
tagent-core-client-0.8.1.tgz
tagent-core-client-0.8.1.tgz.sha256
```

Each tarball contains compiled ESM JavaScript, `.d.ts` declarations, `.js.map` files and `.d.ts.map` files. Each checksum records only the archive basename. The release build validates the package identity/version, tar inventory, runtime imports, public ABI subpaths, typed compilation and joint isolated installation before publishing.

## CI ownership

Core CI must pass canonical ABI fixture decoding, typed client tests, real Fastify provider route/registry checks, profile persistence/restart tests, SDK pack/install tests and the production readiness probe. The real-provider harness intentionally does not emulate Core.

Gateway CI must run the exact current Gateway client against the declared Core release tuple, and must own its Fake Core/container plus connection reset, timeout, malformed/partial response, replay, outbox and external-delivery scenarios. A Core provider test cannot substitute for these Gateway tests.

## Rollout

Deploy Core before Gateway. Require schema ID `tagent-core/0.8`, version `1`, profile readiness with the production credential, zero unresolved `profile_operation_receipts` in `outcome_unknown`, and no stale `started` profile receipt. After an ambiguous operation response, look up the original receipt using the same principal and `Idempotency-Key`; never automatically repeat an unknown effect.
