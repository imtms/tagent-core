# Upgrading to 0.2.x

0.2.0 introduced the breaking architecture, API, deployment, and persistence boundary. The current 0.3.0 release retains that boundary, advances SQLite to schema 36 for lightweight Workspace Goals, and adds execution reliability/efficiency improvements. Upgrade Core before Gateway and Web. Do not perform a rolling multi-writer upgrade.

## Breaking changes

- Supported HTTP routes moved from unversioned `/api/*` to `/api/v1`.
- Core no longer serves the Web Console or an SPA fallback.
- Submissions use the `Idempotency-Key` header and v1 receipt schema.
- ABI compatibility namespaces, client decoders, root facades, and legacy DTO names were removed from the supported surface.
- SQLite advances through schemas 30–36; binaries that only understand schema 34 cannot open schema 36.
- Production requires Node.js `24.18.1` and npm `12+`; the immutable Core artifact targets Linux x64/Node ABI 137.

## Before the upgrade

1. Inventory every Core writer, Gateway/channel consumer, service credential, API path, Web origin, SQLite file, Memory database, Cold store, and release artifact.
2. Update clients and Gateway code to `@tagent/abi`/`@tagent/core-client` v1 contracts.
3. Replace body `requestId` idempotency with the `Idempotency-Key` header.
4. Prepare separate Core and Web deployment locations.
5. Configure the Gateway to validate browser OIDC and translate to an opaque scoped Core credential.
6. Rehearse the migration and rollback from a restored production-like backup.

Stop traffic and all 0.1.x Core writers. Confirm no process holds the database. Back up as one recovery set:

- SQLite database, WAL, and SHM;
- PostgreSQL and Local Cold/S3 Memory state when enabled;
- old Core/Web artifact, configuration, release commit, checksums;
- event-consumer and Learning authority watermarks.

## Database migration

The current 0.2.x line applies these forward migrations:

| Schema | Change |
| --- | --- |
| 30 | canonical Attempt authority, execution leases, checkpoints, recovery comparison |
| 31 | canonical Governance projections and approval receipts |
| 32 | capability authorization constraints and immutable identity |
| 33 | Learning integration journal, fenced delivery, checkpoints, reconciliation, authority, effect receipts, migration issues |
| 34 | Workspace execution preferences and immutable TaskRun model/reasoning snapshots |

The v33 preflight writes ambiguous source rows to `migration_issues`. If any issue remains open, startup stops before serving traffic. Preserve the ledger, correct the underlying data, and rerun the migration. Do not delete or bypass issue rows.

Reopening the migrated database must be idempotent and leave `schema_meta.version=36`.

## Deployment order

1. Deploy and start the candidate Core artifact on the private listener.
2. Require `GET /api/v1/health` to return `data.ok=true` and `data.writer.ready=true`.
3. Verify schema 36, zero open migration issues, one fresh writer lease/fence, and active Learning authority.
4. Start exactly one upgraded Gateway consumer.
5. Claim a new event-consumer generation, replay from the durable ACK position, persist before ACK, and drain lag.
6. Run `scripts/gateway-readiness-probe.mjs`; require exit 0, `ready=true`, and an empty `reasons` list.
7. Deploy the separate Web Console asset with `VITE_TAGENT_CORE_ORIGIN` pointing to the Gateway/API origin.
8. Reopen traffic and monitor writer readiness, consumer lag, terminal ACKs, migration issues, Learning watermarks, and provider/runtime failures.

## Configuration changes

Recommended Core boundary:

```env
HOST=127.0.0.1
PORT=3100
TAGENT_GOVERNANCE_APPROVAL_AUTHORITY=legacy
TAGENT_SERVICE_CREDENTIALS=[{"token":"REPLACE_WITH_24_PLUS_CHAR_TOKEN","scopes":["sessions:read","sessions:write","runs:read","runs:control","events:consume"]}]
```

If an allowed browser origin reaches Core directly, add its exact canonical origin to `TAGENT_CORS_ALLOWED_ORIGINS`. A non-empty allowlist without Core credentials fails startup.

Schema 31 contains canonical Governance projections and receipts, but 0.2.0 keeps the legacy request/decide/consume handlers authoritative. Setting `TAGENT_GOVERNANCE_APPROVAL_AUTHORITY=canonical` fails closed until a later release carries complete canonical-handler evidence.

Web build configuration belongs in `apps/web-console/.env` or the build environment, never the Core `.env`:

```env
VITE_TAGENT_CORE_ORIGIN=https://api.example.com
```

## Verification

- `/api/v1/health` is ready and `/api/health` returns 404;
- client submissions use `Idempotency-Key` and receive v1 envelopes;
- Core serves no `index.html` or Web fallback;
- credentials and resource scopes fail closed;
- schema is 33 with zero open issues;
- exactly one writer fence is fresh;
- Gateway consumer lag and terminal unacknowledged count are zero;
- Learning authority/checkpoints are active and reconciled;
- Memory-disabled and configured Memory/Learning modes match policy.

## Rollback

Do not run a schema-35-only or older binary against schema 36. There is no in-place schema downgrade.

To return to 0.1.x:

1. stop Gateway traffic and all 0.2.x writers;
2. preserve the failed-upgrade database and readiness evidence for diagnosis;
3. restore the complete matching pre-upgrade SQLite/WAL/SHM recovery set;
4. restore the matching PostgreSQL/Cold state when Memory was enabled;
5. restore the matching 0.1.x artifact and configuration;
6. start one old writer and validate it before reopening compatible traffic.

If only Gateway/Web rollback is required, keep schema 36 and use components that understand `/api/v1`, generation-fenced ACKs, and current Learning watermarks. Otherwise keep traffic stopped and deploy a forward-compatible build.
