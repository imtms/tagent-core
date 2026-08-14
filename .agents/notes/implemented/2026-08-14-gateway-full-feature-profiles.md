# Decision: Publish Gateway full-feature profiles from the v0.6.7 baseline

Status: implemented
Kind: architecture

## Problem

Core v0.6.7 already published stable Channel, Workspace Goal, and Operator Read contracts, but Session Settings, Inbox, Context Manifest, Skills, Memory, Learning, Workflow, and Autonomy remained first-party Console or partial Admin surfaces. Gateway could not safely proxy those routes because several used handwritten DTOs, broad scopes, unbounded reads, caller-chosen audit actors, or non-recoverable writes. The existing closed capability schema also could not accept arbitrary new fields without breaking strict v1 clients.

## Decision

Keep the legacy `/api/v1/capabilities`, Channel, Workspace Goal Operator, and Operator Read contracts compatible. Publish a separate `GET /api/v1/capability-profiles` registry and detail route for eight profile `1.0` identities: Session Settings, Session Inbox, Context Manifest, Skills, Memory, Learning, Workflow, and Autonomy. Each detail owns exact endpoint IDs, methods/paths, fine-grained service scopes, resource authority, pagination, retention, compatibility, and recovery semantics.

Use monotonic resource revisions, `If-Match`, `Idempotency-Key`, canonical payload identity, exact replay, and authoritative readback for synchronous resource mutations. Use durable operation receipts only for command-like, asynchronous, externally observable, or outcome-ambiguous effects. Admin receipt lookup has the independent `admin:operations:read` scope. Interrupted effects whose result cannot be proven become `outcome_unknown` and are never automatically replayed.

Schema 47 owns generic profile resource revisions, mutation receipts, operation receipts, audit events, and Inbox/Skill collection revisions. Audit separates the authenticated Core principal and granted scopes from optional delegated actor/request identity and stores no request body. Public projections are bounded and omit prompts, credentials, absolute paths, private tool arguments, arbitrary internal metadata, and private evidence.

Publish independently installable, version-matched `@tagent/abi` and `@tagent/core-client` `.tgz` assets with JavaScript, declarations, JS/declaration source maps, and portable SHA-256 files through the GitHub Release rather than a public npm registry. Core owns canonical fixtures and a real Fastify provider harness. Gateway continues to own OIDC, actor ACLs, projection, persist-before-ACK, outbox/external delivery, Fake Core/network faults, and the current/previous-client matrix.

## Alternatives considered

- Promoting `/api/v1/console/*` unchanged was rejected because route existence is not a stable contract and DTO, pagination, authorization, and recovery behavior varied by feature.
- Adding every profile directly to the closed legacy capability object was rejected because strict existing decoders reject unknown fields and endpoint literals.
- Giving Gateway one `admin` token was rejected because Memory, Learning, Workflow governance, Autonomy decision, Autonomy execution, and receipt lookup are independently enforceable security domains.
- A universal operation table for every PATCH, PUT, and DELETE was rejected because conditional synchronous updates can recover through exact replay and readback without pretending every local mutation is asynchronous work.
- A Core-owned Fake Gateway/Core process was rejected because Gateway owns transport faults, outbox, and compatibility policy; Core instead proves canonical fixtures against its real provider.

## Verification

- `npm run check` passes package builds, root/test TypeScript checks, Web Console checks, and the decision-record gate.
- `npm run lint` passes with zero warnings.
- `npm test` passes 1,161 tests in 134 files; two PostgreSQL cases and one live-LLM Memory quality case remain environment-gated without their external test URLs.
- `npm run build` produces the Core server and independent Web Console build.
- `tests/capability-profiles-api.test.ts`, the Operator/Admin profile API suites, `tests/gateway-profile-persistence.test.ts`, and `tests/gateway-profile-provider-contract.test.ts` prove discovery, scopes, resource authority, exact replay, receipts, redaction, persistence/restart behavior, 8 profiles, 41 unique real routes, and 19 canonical fixture groups.
- `tests/sdk-release.test.ts` packs and jointly installs both SDK archives, verifies runtime/type imports, source maps, portable checksums, and release-workflow integration.
- `tests/gateway-production-readiness.test.ts` proves schema 47 migration/re-entry, full production scope parsing, capability-profile negotiation, CORS headers, and critical readiness for unresolved profile receipts.

## Consequences

Gateway must negotiate each full-feature profile with the same Core principal used for calls and keep unavailable or incompatible features disabled. Deployments enabling all profiles need the new scopes and wildcard Workspace resource authority; existing routes retain their previous scopes. Strict profile decoders require a matching SDK whenever a profile response changes.

Schema 47 is forward-only: a schema-46-only binary must not open the migrated database. Profile receipts and audit rows have no automatic deletion in profile 1.0, so operators must monitor their growth and unresolved states. Releases now attach eight files across Core, Web, ABI, Core Client, and checksums, but internal runtime workspaces remain private and no npm publish occurs.
