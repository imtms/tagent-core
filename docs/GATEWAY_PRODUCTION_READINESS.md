# Gateway production readiness

This runbook is the Core-side production gate for a Gateway consuming the v1 Channel and capability profiles. A passing probe is necessary but does not prove Gateway-owned browser identity, ACL, persist-before-ACK storage, routing, outbox, or external delivery.

Gateway is the browser identity boundary. It validates browser OIDC/JWT credentials, removes them, and connects to private Core with a minimum-scope opaque service credential.

## Release gate

Use the matching Core, Web Console, ABI SDK, and Core Client assets from the same GitHub Release. From the unpacked Core artifact:

```sh
node scripts/release-manifest.mjs verify "$PWD"
```

The command must verify the release manifest, commit marker, runtime ABI, native SQLite binding, materialized workspace packages, and checksums.

## Configuration gate

A Gateway enabling every profile needs the five Channel scopes, the profile scopes below, and an explicit resource grant. Narrower deployments may omit a profile only when all of its endpoints are disabled.

```sh
TAGENT_SERVICE_CREDENTIALS='[{"token":"REPLACE_WITH_24_PLUS_CHAR_TOKEN","scopes":["sessions:read","sessions:write","runs:read","runs:control","events:consume","operator:session-settings:read","operator:session-settings:write","operator:inbox:read","operator:inbox:write","operator:inbox:control","operator:context-manifests:read","operator:skills:read","operator:skills:write","admin:memory:read","admin:memory:write","admin:operations:read"],"principal":{"subjectId":"gateway-production","resourceScopes":[{"type":"workspace","id":"*"}]}}]' \
node --input-type=module <<'NODE'
import { loadConfig } from "@tagent/core-service/config";
const config = loadConfig(process.env);
const gateway = config.serviceCredentials.find((item) => item.scopes.includes("events:consume"));
if (!gateway || gateway.principal?.subjectId !== "gateway-production"
  || gateway.principal.resourceScopes.length !== 1
  || gateway.principal.resourceScopes[0]?.type !== "workspace"
  || gateway.principal.resourceScopes[0]?.id !== "*") process.exit(1);
process.stdout.write(JSON.stringify({ scopes: gateway.scopes, principal: gateway.principal }));
NODE
```

## Current-schema gate

Core 0.8 creates or upgrades the exact legacy 0.8 shape to current revision 2, then validates its marker, migration journal/checksums, and complete schema. On an isolated deployment path, open the intended database twice:

```sh
TAGENT_DB=/var/lib/tagent/core.sqlite \
node --input-type=module <<'NODE'
import { Store } from "@tagent/persistence-sqlite/store";
const store = new Store(process.env.TAGENT_DB);
const schemaId = store.db.prepare("SELECT schema_id AS schemaId FROM core_schema WHERE id=1").get().schemaId;
const schemaVersion = store.getSchemaVersion();
const activeTables = ["attempts", "approval_receipts", "task_run_command_receipts", "workspace_goal_operation_receipts", "profile_operation_receipts"]
  .every((name) => store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
store.close();
process.stdout.write(JSON.stringify({ schemaId, schemaVersion, activeTables }));
NODE
```

Both opens must exit `0` and return:

```json
{"schemaId":"tagent-core/0.8","schemaVersion":2,"activeTables":true}
```

The second open proves idempotent migration and exact current-shape validation. A different marker, unsupported revision, journal mismatch, or any `sqlite_master` drift blocks deployment and requires recovery from backup.

## Runtime probe

The release probe opens SQLite read-only and calls the real health, capabilities, Operator Read, registry, and profile-detail endpoints:

```sh
TAGENT_DB=/var/lib/tagent/core.sqlite \
TAGENT_HEALTH_URL=http://127.0.0.1:3100/api/v1/health \
TAGENT_CAPABILITIES_URL=http://127.0.0.1:3100/api/v1/capabilities \
TAGENT_OPERATOR_READ_CAPABILITIES_URL=http://127.0.0.1:3100/api/v1/operator/capabilities \
TAGENT_CAPABILITY_PROFILES_URL=http://127.0.0.1:3100/api/v1/capability-profiles \
TAGENT_GATEWAY_CORE_TOKEN=REPLACE_WITH_24_PLUS_CHAR_TOKEN \
TAGENT_GATEWAY_CONSUMER_ID=gateway-production \
node scripts/gateway-readiness-probe.mjs
```

Exit codes:

| Exit | Meaning |
| --- | --- |
| `0` | Every Core gate passed. |
| `1` | Probe ran and one or more gates failed; `reasons` is authoritative. |
| `2` | Probe could not run, for example because the database is missing or unreadable. |

The current output has `probeVersion: 7`, `schemaId: "tagent-core/0.8"`, and `schemaVersion: 2`. The probe reads the actual SQLite `PRAGMA user_version`; important fields are:

| Field | Meaning |
| --- | --- |
| `writerReady`, `writerLeaseFresh`, writer identity/fence/timestamps | HTTP writer readiness combined with the durable lease |
| `consumerLag` | Maximum `runs.last_event_seq - event_consumers.acked_seq` for the configured consumer |
| `settledUnacked`, `finalUnacked` | terminal boundaries not durably ACKed |
| `receipts.commands`, `receipts.workspaceGoals`, `receipts.capabilityProfiles` | started/unknown receipt health |
| `capabilities`, `operatorReadCapabilities`, `capabilityProfiles` | authenticated contract compatibility results |
| `ready`, `severity`, `reasons` | final gate decision |

The probe requires the base command/event catalogs, interaction support, Operator endpoint list, ready Approval contract, exact replay/no-blind-replay semantics, `operator.read.v1`, and all five capability profile `1.0` summaries and details for the actual principal.

## Exact thresholds

| Gate | Ready | Critical |
| --- | --- | --- |
| Schema | ID `tagent-core/0.8`, version `2` | missing or different |
| Writer | health ready and lease fresh | unavailable or stale |
| Consumer lag | `0` | `>= 10000`; any positive value still blocks readiness |
| Settled/final ACK | both `0` | oldest unsettled age `>= 120000 ms`; any positive value blocks |
| Receipts | no `outcome_unknown`; `started` younger than 120 s may be live work | unknown outcome or started age `>= 120000 ms` |
| Capability contracts | all compatible and available | any endpoint, scope, pagination, retention, or recovery mismatch |

## Diagnostic SQL

```sql
SELECT schema_id FROM core_schema WHERE id = 1;

SELECT lock_name, owner_id, fence, heartbeat_at, expires_at, released_at
FROM core_writer_lease
WHERE lock_name = 'core-writer';

SELECT r.id, r.last_event_seq, COALESCE(ec.acked_seq, 0) AS acked_seq,
       ec.settled_acked_seq, ec.final_acked_seq
FROM runs AS r
LEFT JOIN event_consumers AS ec
  ON ec.run_id = r.id AND ec.consumer_id = 'gateway-production'
ORDER BY r.updated_at, r.id;

SELECT status, COUNT(*) AS count, MIN(updated_at) AS oldest_updated_at
FROM task_run_command_receipts
WHERE status IN ('started','outcome_unknown')
GROUP BY status;

SELECT status, COUNT(*) AS count, MIN(updated_at) AS oldest_updated_at
FROM workspace_goal_operation_receipts
WHERE status IN ('started','outcome_unknown')
GROUP BY status;

SELECT status, COUNT(*) AS count, MIN(updated_at) AS oldest_updated_at
FROM profile_operation_receipts
WHERE status IN ('started','outcome_unknown')
GROUP BY status;
```

## Deploy and rollback

1. Stop Gateway admission and all Core writers.
2. Verify the release and configuration gates.
3. Back up and validate an exact revision-1 Core database, or provision an empty database, then pass the revision-2 schema gate.
4. Start Core, then start one Gateway writer and claim fresh event-consumer generations.
5. Run the runtime probe and admit traffic only when it exits `0`, returns `ready=true`, and has no reasons.

For rollback, stop admission and writers first. A replacement build may reuse the database only if it accepts the exact `tagent-core/0.8` shape and current ABI/profile window. Otherwise keep the current release or start the replacement with a new empty database. Never point an older incompatible binary at the current database, change `core_schema`, or restore an earlier schema over live files.
