# Decision: Publish current Gateway full-feature profiles

Status: implemented
Kind: architecture

## Problem

Session Settings, Inbox, Context Manifest, Skills, and Memory require cross-team contracts distinct from first-party Console and private Admin surfaces. Gateway cannot safely proxy handwritten DTOs, broad scopes, unbounded reads, caller-chosen audit actors, or non-recoverable writes. The base capability schema and the independently negotiated feature registry also describe different authorities and should not be conflated.

## Decision

Publish `/api/v1/capabilities` as the current base Channel, Workspace Goal Operator, and Operator Read contract. Publish a separate `GET /api/v1/capability-profiles` registry and detail route for five profile `1.0` identities: Session Settings, Session Inbox, Context Manifest, Skills, and Memory. Each detail owns exact endpoint IDs, methods/paths, fine-grained service scopes, resource authority, pagination, retention, release identity, and recovery semantics.

Use monotonic resource revisions, `If-Match`, `Idempotency-Key`, canonical payload identity, exact replay, and authoritative readback for synchronous resource mutations. Consult an existing mutation receipt before mutable configuration validation, live readback, Router work, or filesystem staging, and persist the complete public projection plus ETag source needed for immutable replay. Use durable operation receipts only for command-like, asynchronous, externally observable, or outcome-ambiguous effects. Admin receipt lookup has the independent `admin:operations:read` scope. Interrupted effects whose result cannot be proven become `outcome_unknown` and are never automatically replayed.

The current schema directly owns generic profile resource revisions, mutation receipts, operation receipts, audit events, and Inbox/Skill collection revisions. Snapshot lists use immutable creation or binding order keys; Memory pushes `limit + 1` cursor queries into its backing repository rather than paginating a capped export. Audit separates the authenticated Core principal and granted scopes from optional delegated actor/request identity and stores no request body. Public resource projections are bounded and omit prompts, credentials, absolute paths, arbitrary internal metadata, and private evidence. The authorized TaskRun transcript is the explicit exception: one unified Channel endpoint returns durable model reasoning, tool arguments, and tool results to every `runs:read` caller, including Web. Its `after` sequence is exclusive: a pending tool uses the call row sequence, while a later completed/failed projection uses the result row sequence and the same `toolCallId`. CoreClient owns Web SSE decoding, and Web follows `pageInfo` until the target durable sequence is consumed before advancing its cursor.

Publish independently installable, version-matched `@tagent/abi` and `@tagent/core-client` `.tgz` assets with JavaScript, declarations, JS/declaration source maps, and portable SHA-256 files through the GitHub Release rather than a public npm registry. Core owns canonical fixtures and a real Fastify provider harness. Gateway continues to own OIDC, actor ACLs, projection, persist-before-ACK, outbox/external delivery, and Fake Core/network faults. Core and Gateway integrate only with the exact current release tuple.

## Alternatives considered

- Promoting `/api/v1/console/*` unchanged was rejected because route existence is not a stable contract and DTO, pagination, authorization, and recovery behavior varied by feature.
- Adding every profile directly to the base capability object was rejected because base discovery and feature-specific authorization/recovery are separate contracts.
- Giving Gateway one `admin` token was rejected because Memory mutation and receipt lookup are independently enforceable security domains, while operator profiles require distinct scopes.
- A universal operation table for every PATCH, PUT, and DELETE was rejected because conditional synchronous updates can recover through exact replay and readback without pretending every local mutation is asynchronous work.
- A Core-owned Fake Gateway/Core process was rejected because Gateway owns transport faults and outbox behavior; Core instead proves canonical fixtures against its real provider.

## Verification

- `npm run check` passes package builds, root/test TypeScript checks, Web Console checks, and the decision-record gate.
- `npm run lint` passes with zero warnings.
- `npm test` covers the current profiles, providers, persistence, SDKs, and runtime; PostgreSQL and live-LLM cases remain environment-gated without their external services.
- `npm run build` produces the Core server and independent Web Console build.
- `tests/capability-profiles-api.test.ts`, the Operator/Admin profile API suites, `tests/gateway-profile-persistence.test.ts`, and `tests/gateway-profile-provider-contract.test.ts` prove discovery, scopes, resource authority, receipt-first exact replay, immutable replay projections/ETags, stable update-between-pages snapshots, complete 501-member traversal, bounded identifiers, redaction, persistence/restart behavior, 5 profiles, 27 unique real routes, and 13 canonical fixture groups.
- `tests/sdk-release.test.ts` packs and jointly installs both SDK archives, verifies runtime/type imports, source maps, portable checksums, and release-workflow integration.
- `tests/gateway-production-readiness.test.ts` proves current-schema re-entry, full production scope parsing, capability-profile negotiation, CORS headers, and critical readiness for unresolved profile receipts.
- `tests/v1-api-differential.test.ts` proves that the unified Channel transcript returns durable reasoning, Bash arguments, and tool results without a separate Console route and never exposes hydrated items at or below an exclusive cursor.
- `tests/web-api.test.ts` proves that the first-party Console drains a 201-item Transcript through the advertised page cursor before advancing its consumed sequence.

## Consequences

Gateway must negotiate each full-feature profile with the same Core principal used for calls and keep unavailable features disabled. Deployments enabling all profiles need the declared scopes and Workspace resource authority. Strict profile decoders require the SDK from the matching Core release.

Only the exact current schema and Core/SDK tuple is supported; earlier databases and clients are not accepted. Profile receipts and audit rows have no automatic deletion in profile 1.0, so operators must monitor their growth and unresolved states. Releases attach eight files across Core, Web, ABI, Core Client, and checksums, but internal runtime workspaces remain private and no npm publish occurs. A principal with `runs:read` can inspect stored reasoning, commands, paths, tool arguments, and full tool output, so deployments must treat that scope as transcript-sensitive authority. A durable Transcript page can legitimately project no items when it contains only tool-result context already represented on an earlier page; clients must still exhaust `pageInfo`.
