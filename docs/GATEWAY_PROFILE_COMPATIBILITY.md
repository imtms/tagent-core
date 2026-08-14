# Gateway profile compatibility

This matrix is the release boundary for the full-feature Core/Gateway contract. It covers Core-owned wire and provider behavior only; Gateway still owns OIDC/ACL, inbound/outbox delivery, Fake Core and network-fault tests.

## Current release tuple

| Component | Required value |
| --- | --- |
| Core | `0.7.0` |
| SQLite | `47` |
| Capability registry | `GET /api/v1/capability-profiles` |
| Profile versions | all eight profiles at `1.0` |
| ABI SDK | `@tagent/abi@0.7.0` |
| Typed client SDK | `@tagent/core-client@0.7.0` |
| Node.js | `>=24.18.1` for the SDK; Core release uses exactly `24.18.1` |

The eight profile identities are `operator.session-settings.v1`, `operator.session-inbox.v1`, `operator.context-manifest.v1`, `operator.skills.v1`, `admin.memory.v1`, `admin.learning.v1`, `admin.workflow.v1`, and `admin.autonomy.v1`.

## Support matrix

| Core/provider | Gateway SDK | Full-feature support |
| --- | --- | --- |
| Core `0.7.0`, schema `47`, all required profile summaries/details available | ABI + Core Client `0.7.0` | Supported |
| Core `0.7.0`, schema `47` | hand-written DTOs or direct Console/Admin calls | Unsupported |
| Core `0.6.7` or earlier, no capability registry | `0.7.0` profile client | Unsupported for profile features; Gateway must keep them disabled |
| Core `0.7.0`, required profile partially available/unavailable to the actual service principal | any | Unsupported for that profile until scopes/resource grants are corrected |
| Future profile minor with additive strict response fields | `0.7.0` strict decoder | Unsupported until a matching SDK is deployed |
| Future profile major | any `1.x` client | Unsupported without the named migration and new major client |

Compatibility is negotiated per feature. A healthy Core or compatible legacy `/api/v1/capabilities` response does not enable a missing full-feature profile. Gateway must validate the registry and the selected profile detail using the same authenticated service principal that will call its endpoints.

## Release assets

The GitHub Release attaches these SDK artifacts in addition to Core and Web Console archives:

```text
tagent-abi-0.7.0.tgz
tagent-abi-0.7.0.tgz.sha256
tagent-core-client-0.7.0.tgz
tagent-core-client-0.7.0.tgz.sha256
```

Each tarball contains compiled ESM JavaScript, `.d.ts` declarations, `.js.map` files and `.d.ts.map` files. Each checksum records only the archive basename. The release build validates the package identity/version, tar inventory, runtime imports, public ABI subpaths, typed compilation and joint isolated installation before publishing.

## CI ownership

Core CI must pass canonical ABI fixture decoding, typed client tests, real Fastify provider route/registry checks, profile persistence/restart tests, SDK pack/install tests and the production readiness probe. The real-provider harness intentionally does not emulate Core.

Gateway CI must run its supported current and previous Gateway client versions against the declared Core release tuple, and must own its Fake Core/container plus connection reset, timeout, malformed/partial response, replay, outbox and external-delivery scenarios. A Core provider test cannot substitute for these Gateway tests.

## Rollout

Deploy Core before Gateway. Require schema `47`, profile readiness with the production credential, zero unresolved `profile_operation_receipts` in `outcome_unknown`, and no stale `started` profile receipt. After an ambiguous operation response, lookup the original receipt using the same principal and `Idempotency-Key`; never automatically repeat an unknown effect.
