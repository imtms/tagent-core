# Gateway Production Readiness

This runbook is the production gate for a Gateway that consumes the Core v1 channel. Deployment is blocked when any required gate fails.

This runbook verifies the Core release and runtime side of the Gateway contract. A passing probe is necessary but cannot prove Gateway-local persist-before-ACK, identity, routing, outbox or external delivery. The exact responsibility decision and Core evidence are tracked in [GATEWAY_HANDOFF_STATUS.md](GATEWAY_HANDOFF_STATUS.md).

The Gateway is an external channel and identity boundary. Core does not validate browser OIDC/JWT tokens; the Gateway must validate them, strip the browser credential, and use a minimal opaque Core service credential on the private upstream connection.

All commands below run from the unpacked Core release directory. The release contains materialized `@tagent/core-service` and `@tagent/persistence-sqlite` packages plus `scripts/gateway-readiness-probe.mjs`; none of these commands depend on the source checkout.

The tag-triggered release workflow builds Core and Web Console archives in one release job, uploads both archives and checksums as a 30-day Actions artifact, and attaches all four files to the GitHub Release. Acquire the Core artifact and matching checksum from that release output.

## Release and configuration gates

Verify the release manifest, commit marker, runtime ABI, native SQLite binding, materialized internal packages, and checksums:

```sh
node scripts/release-manifest.mjs verify "$PWD"
```

Validate the Gateway service credential through the production config parser. The token must contain at least 24 characters and include `sessions:read`, `sessions:write`, `runs:read`, `runs:control`, and `events:consume` for the full profile:

```sh
TAGENT_SERVICE_CREDENTIALS='[{"token":"REPLACE_WITH_24_PLUS_CHAR_TOKEN","scopes":["sessions:read","sessions:write","runs:read","runs:control","events:consume"],"principal":{"subjectId":"gateway-production","resourceScopes":[{"type":"workspace","id":"production"}]}}]' \
node --input-type=module <<'NODE'
import { loadConfig } from "@tagent/core-service/config";
const config = loadConfig(process.env);
const gateway = config.serviceCredentials.find((item) => item.scopes.includes("events:consume"));
if (!gateway || !["sessions:read","sessions:write","runs:read","runs:control"].every((scope) => gateway.scopes.includes(scope))
  || gateway.principal?.subjectId !== "gateway-production"
  || gateway.principal.resourceScopes.length !== 1
  || gateway.principal.resourceScopes[0]?.type !== "workspace"
  || gateway.principal.resourceScopes[0]?.id !== "production") process.exit(1);
process.stdout.write(JSON.stringify({ credentialCount: config.serviceCredentials.length, scopes: gateway.scopes, principal: gateway.principal }));
NODE
```

The command must exit `0` and return one credential with all required scopes and the exact bounded principal translation. A parser error, missing scope, or altered principal blocks deployment.

## Schema migration gate

Migration v30 → v31 → v32 → v33 → v34 → v35 → v36 → v37 → v38 → v39 → v40 → v41 → v42 → v43 is performed by the production `Store` opener. Back up the database and its WAL/SHM files, then run this command twice:

```sh
TAGENT_DB=/var/lib/tagent/core.sqlite \
node --input-type=module <<'NODE'
import { Store } from "@tagent/persistence-sqlite/store";
const store = new Store(process.env.TAGENT_DB);
const schemaVersion = store.db.prepare("SELECT version FROM schema_meta WHERE id=1").get().version;
const objects = store.db.prepare(`SELECT name FROM sqlite_master
  WHERE name IN ('attempts','approval_receipts','idx_operations_attempt_created',
    'idx_run_checks_source_operation','idx_sessions_operator_created',
    'idx_runs_operator_session_created','idx_runs_operator_session_updated',
    'integration_outbox','learning_projection_authority_state',
    'workspace_goal_inbox_links','workspace_goal_roadmap_item_progress','session_create_receipts',
    'task_run_command_receipts','workspace_goal_operation_receipts','submission_audit_receipts',
    'skills','skill_revisions','session_skill_bindings') ORDER BY name`)
  .all().map((row) => row.name);
const goalRunLinkColumns = store.db.prepare("PRAGMA table_info(workspace_goal_run_links)").all().map((row) => row.name);
store.close();
process.stdout.write(JSON.stringify({ schemaVersion, objects, hasGoalLinkMode: goalRunLinkColumns.includes('link_mode') }));
NODE
```

Both runs must exit `0` and return exactly:

```json
{"schemaVersion":43,"objects":["approval_receipts","attempts","idx_operations_attempt_created","idx_run_checks_source_operation","idx_runs_operator_session_created","idx_runs_operator_session_updated","idx_sessions_operator_created","integration_outbox","learning_projection_authority_state","session_create_receipts","session_skill_bindings","skill_revisions","skills","submission_audit_receipts","task_run_command_receipts","workspace_goal_inbox_links","workspace_goal_operation_receipts","workspace_goal_roadmap_item_progress"],"hasGoalLinkMode":true}
```

The second open is the idempotence proof. A different version or object inventory blocks deployment.

## Production readiness probe

The probe is read-only. It opens `TAGENT_DB` with SQLite read-only mode, calls the real Core health and capabilities endpoints, and emits one JSON object:

```sh
TAGENT_DB=/var/lib/tagent/core.sqlite \
TAGENT_HEALTH_URL=http://127.0.0.1:3100/api/v1/health \
TAGENT_CAPABILITIES_URL=http://127.0.0.1:3100/api/v1/capabilities \
TAGENT_OPERATOR_READ_CAPABILITIES_URL=http://127.0.0.1:3100/api/v1/operator/capabilities \
TAGENT_GATEWAY_CORE_TOKEN=REPLACE_WITH_24_PLUS_CHAR_TOKEN \
TAGENT_GATEWAY_CONSUMER_ID=gateway-production \
node scripts/gateway-readiness-probe.mjs
```

Exit codes:

| Exit | Meaning |
| --- | --- |
| `0` | Every readiness gate passed. |
| `1` | Probe completed and at least one readiness gate failed. The JSON `reasons` array is authoritative. |
| `2` | Probe could not run, such as a missing `TAGENT_DB` or unreadable database. |

Stable top-level JSON fields:

| Field | Source |
| --- | --- |
| `schemaVersion` | `schema_meta.version` |
| `migrationOpenIssues` | Count of open rows in `migration_issues` |
| `writerReady` | `/api/v1/health` field `data.writer.ready` combined with the SQLite lease freshness check |
| `writerOwnerId`, `writerFence`, `writerExpiresAt`, `writerReleasedAt`, `writerLeaseFresh` | `core_writer_lease` for `lock_name='core-writer'` |
| `consumerLag` | Maximum per-run `runs.last_event_seq - event_consumers.acked_seq` for the configured consumer |
| `settledUnacked`, `finalUnacked` | Recoverable settled and irreversible final Runs whose durable ACK watermark has not reached `runs.last_event_seq` |
| `terminalUnacked`, `terminalOldestUnackedAgeMs` | Deprecated compatibility alias/age for the settled boundary |
| `receipts.commands`, `receipts.workspaceGoals` | `started`/`outcomeUnknown` counts and oldest uncertain receipt age |
| `authority`, `authorityReady` | `learning_projection_authority_state`; only `legacy_active` and `integration_active` are ready |
| `watermarks` | `learning_projection_checkpoint` rows ordered by consumer and delivery role |
| `health` | HTTP reachability, status, `data.ok`, and `data.writer.ready` from `GET /api/v1/health` |
| `capabilities` | Compatibility decision and negotiated catalog from `GET /api/v1/capabilities` |
| `operatorReadCapabilities` | Independent compatibility decision and contract from `GET /api/v1/operator/capabilities` |
| `ready`, `severity`, `reasons` | Final gate decision |

The Core health response used by the probe must include at least this subset;
additional versioned health fields may be present:

```json
{"data":{"ok":true,"service":"tagent-core","writer":{"ready":true}},"requestId":"REQUEST_ID"}
```

An unavailable writer returns HTTP `503` with `data.ok=false` and `data.writer.ready=false`.

## Exact thresholds

These are embedded in the probe output under `thresholds`:

| Field | Ready | Warning and not ready | Critical and not ready |
| --- | --- | --- | --- |
| `consumerLag` | `0` | `>= 1` | `>= 10000` |
| `settledUnacked`, `finalUnacked` | `0` | `>= 1` | Oldest pending settled ACK age `>= 120000 ms` |
| Receipt health | No `outcome_unknown`; `started` younger than `120000 ms` is observable in-flight work | Not applicable | Any `outcome_unknown` or `started` age `>= 120000 ms` |
| `writerLeaseFresh` | `true` | Not applicable | `false` |
| `migrationOpenIssues` | `0` | Not applicable | Missing table or any open issue |
| `authorityReady` | `true` | Transition state `switching` or `rollback` | Missing authority state |
| `schemaVersion` | `43` | Not applicable | Missing or not `43` |
| `capabilities.compatible` | `true` | Not applicable | Missing endpoint/catalog/profile or wrong schema |
| `operatorReadCapabilities.compatible` | `true` | Not applicable | Missing endpoint, pagination/retention guarantee or wrong profile |

Consumer lag semantics are strict: any value greater than zero makes the Gateway not ready immediately. Warning and critical distinguish alert urgency; they never permit traffic.

## SQL evidence

The probe uses these production tables. Operators may run the equivalent read-only queries when diagnosing a failed reason.

```sql
SELECT version FROM schema_meta WHERE id = 1;
SELECT migration_version, code, source_ref, status
FROM migration_issues
WHERE status = 'open'
ORDER BY migration_version, code, source_ref;

SELECT lock_name, owner_id, fence, pid, host, heartbeat_at, expires_at, released_at
FROM core_writer_lease
WHERE lock_name = 'core-writer';

SELECT
  r.id AS task_run_id,
  r.last_event_seq,
  COALESCE(ec.acked_seq, 0) AS acked_seq,
  r.last_event_seq - COALESCE(ec.acked_seq, 0) AS consumer_lag,
  ec.settled_acked_seq,
  ec.final_acked_seq
FROM runs AS r
LEFT JOIN event_consumers AS ec
  ON ec.run_id = r.id AND ec.consumer_id = 'gateway-production'
ORDER BY r.updated_at, r.id;

SELECT active_source, generation, switch_watermark, legacy_last_acked,
       legacy_resume_position, integration_checkpoint, rollback_checkpoint, status
FROM learning_projection_authority_state
WHERE id = 1;

SELECT consumer, delivery_role, watermark, generation, updated_at
FROM learning_projection_checkpoint
ORDER BY consumer, delivery_role;

SELECT status, COUNT(*) AS count, MIN(updated_at) AS oldest_updated_at
FROM task_run_command_receipts
WHERE status IN ('started','outcome_unknown')
GROUP BY status;

SELECT status, COUNT(*) AS count, MIN(updated_at) AS oldest_updated_at
FROM workspace_goal_operation_receipts
WHERE status IN ('started','outcome_unknown')
GROUP BY status;
```

## Release gate matrix

| Gate | PASS | FAIL |
| --- | --- | --- |
| Manifest | The production verifier exits `0`. | Verifier exits non-zero. |
| Configuration | The release-local production parser returns the required Gateway scopes. | Parser rejects the environment or a scope is missing. |
| Migration | Both release-local `Store` opens return schema `41`, the exact object inventory and `hasGoalLinkMode=true`. | Open fails, output differs, or the second open is not idempotent. |
| Capabilities | Probe negotiates the command/event catalogs, legacy Operator allowlist, `operator.read.v1`, Approval authority, receipt protocol, retention and limits. | Endpoint is unavailable, under-scoped, wrong-versioned or missing a required item. |
| Writer | Probe returns `writerReady=true`, a fresh lease, and one current fence. | Health or SQLite lease evidence is not ready. |
| Persist-before-ACK | The exact `(task_run_id, consumer_id, generation, sequence, event_id)` receipt is durable before its ACK. | ACK has no exact receipt, relies only on a sequence, or precedes the receipt commit. |
| Replay | A persisted-but-unacked event is promoted to the reclaimed generation, deduped, ACKed, and then quiescent. | Replay is lost, duplicated, stale, or skips the durable ACK. |
| Lag and ACK | Probe returns `consumerLag=0`, `settledUnacked=0`, and `finalUnacked=0`. | Any field is non-zero. |
| Receipt recovery | No `outcome_unknown` receipt exists and every `started` receipt is younger than 120 seconds. | Unknown outcomes need reconciliation or an in-flight receipt is stale. |
| Learning authority | Probe returns `authorityReady=true` and durable watermarks. | Authority is missing or in a transition state. |

Any FAIL result blocks deployment. Liveness alone does not override readiness. A PASS proves only the declared Core runtime gates; Gateway still proves its own durable inbound/outbox/ACK behavior, fake-Core scenarios and supported-client release matrix.

## Deploy order

Use **Core before Gateway** order:

1. Stop Gateway traffic admission while retaining the prior compatible Gateway source for rollback.
2. Back up the SQLite database, WAL/SHM files, and current release pointer.
3. Verify the Core release manifest from the unpacked release directory.
4. Execute the release-local production configuration gate.
5. Execute the release-local Store migration command twice.
6. Deploy and start Core.
7. Start exactly one Gateway writer and reclaim its Core consumer generation.
8. Execute `scripts/gateway-readiness-probe.mjs` from the release directory.
9. Admit traffic only when the probe exits `0`, returns `ready=true`, and reports an empty `reasons` array.

## Rollback point

The rollback point is the last verified prior compatible Gateway source plus the recorded Core consumer and Learning watermarks. Schema v43 is forward-only during application rollback.

Rollback steps:

1. Close Gateway traffic admission and stop new submissions.
2. Save the last successful probe JSON, especially `writerFence`, capability negotiation, `consumerLag`, settled/final ACKs, command/Goal receipts, `authority`, and `watermarks`.
3. Stop the new Gateway writer or wait for its lease to expire; require the replacement owner to obtain a higher fence.
4. Activate the prior compatible Gateway source through the production learning authority rollback API.
5. Reclaim the Core event consumer, receiving a new generation.
6. Resume after the durable ACK watermark; replay persisted-but-unacked events and persist the new-generation exact receipt before ACK.
7. Keep schema version `43`. Do not restore an older database over it.
8. Run the release-local readiness probe again and reopen traffic only after exit `0`.

If the prior deployment cannot coexist with schema v43 or honor the current receipt/ACK contract, keep traffic stopped and deploy a forward-compatible build. Do not perform a destructive schema downgrade.
