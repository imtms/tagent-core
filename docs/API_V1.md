# API v1

## Contract source

All supported Core HTTP endpoints use `/api/v1`. `@tagent/abi` is the wire-contract source of truth; `@tagent/core-client` validates requests, responses, SSE events, and errors against that ABI.

Core is API-only. Unversioned paths such as `/api/health`, `/api/sessions`, `/api/runs/*`, and `/api/memory/*` are removed and return 404. Core does not serve static files or an SPA fallback.

## Route surfaces

| Surface | Prefix/examples | Purpose |
| --- | --- | --- |
| Public | `GET /api/v1/health` | process and writer readiness; no credential required |
| Channel | `/api/v1/sessions`, `/api/v1/task-runs/*` | durable submission, TaskRun reads and commands, transcript, artifacts, event consumers |
| Console | `/api/v1/console/*` | operator projections and controls used by the Web Console |
| Admin | `/api/v1/admin/*` | configuration, Memory, Learning, Workflow, and governance operations |
| Internal | `/api/v1/internal/*` | trusted workflow evaluation and worker integration |

Selected channel routes:

```text
POST /api/v1/sessions
GET  /api/v1/sessions/:sessionId
POST /api/v1/sessions/:sessionId/submissions
GET  /api/v1/sessions/:sessionId/submissions/:idempotencyKey
GET  /api/v1/task-runs/:taskRunId
POST /api/v1/task-runs/:taskRunId/commands
GET  /api/v1/task-runs/:taskRunId/commands/:commandId
GET  /api/v1/task-runs/:taskRunId/interactions?after=OFFSET&limit=100
GET  /api/v1/task-runs/:taskRunId/transcript?after=SEQUENCE&limit=100
GET  /api/v1/task-runs/:taskRunId/artifacts
GET  /api/v1/task-runs/:taskRunId/artifacts/:artifactId/content
POST /api/v1/task-runs/:taskRunId/event-consumers/:consumerId/claim
GET  /api/v1/task-runs/:taskRunId/events
POST /api/v1/task-runs/:taskRunId/event-consumers/:consumerId/ack
GET  /api/v1/capabilities
```

Use the exported schemas for the complete route payload inventory. Console projections are richer than channel resources and are not a substitute for the stable channel contract.

### Workspace Goal Console routes

The first-party Web Console manages lightweight Workspace Goals through the operator surface:

```text
GET  /api/v1/console/workspaces/:workspaceId/goals
POST /api/v1/console/workspaces/:workspaceId/goals
GET  /api/v1/console/workspace-goals/:goalId
POST /api/v1/console/workspace-goals/:goalId/definition-revisions
POST /api/v1/console/workspace-goals/:goalId/roadmaps
POST /api/v1/console/workspace-goals/:goalId/roadmap/generate
GET  /api/v1/console/workspace-goals/:goalId/operations/:requestId
POST /api/v1/console/workspace-goals/:goalId/decisions
POST /api/v1/console/workspace-goals/:goalId/task-runs
```

These routes form the stable Workspace Goal subset of the Operator profile. They use `sessions:read` or `sessions:write`, standard v1 envelopes and Console Goal ABI schemas. Every Goal write requires a stable `requestId`. Definition/Roadmap edits and LLM Roadmap generation use durable operation receipts; `operations/:requestId` exposes `started`, `succeeded`, `failed`, or `outcome_unknown`. A repeated generation request never invokes the model again. After user editing and approval, `task-runs` starts an approved Roadmap item through normal admission. Ordinary user-started TaskRuns in the Workspace automatically receive the unique active Goal definition as immutable direction. `/plans`, `/run-links` and `/evidence` are removed and return 404. See [WORKSPACE_GOALS.md](WORKSPACE_GOALS.md).

### Memory provenance

Memory source references use one Admin v1 ABI vocabulary across the Memory domain and Console projections:

```text
message  run  transcript  manual  check  artifact  operation
```

`POST /api/v1/admin/memory/jobs` preserves these source types in `request.sourceRefs`; clients must validate them with `MemorySourceReferenceSchema` (or the Console alias) without rewriting historical provenance.

## JSON envelopes

Every successful JSON response has this shape:

```json
{
  "data": {},
  "requestId": "request-123"
}
```

Every JSON failure has this shape:

```json
{
  "error": {
    "code": "auth.permission_denied",
    "message": "Insufficient service credential scope",
    "requestId": "request-123",
    "retryable": false,
    "details": {}
  }
}
```

Send an optional `X-Request-Id` containing 1–128 letters, digits, `.`, `_`, `:`, or `-`. Core echoes the accepted/generated value in `X-Request-Id` and the JSON envelope.

Binary artifact responses and SSE streams use their media protocols rather than a JSON success envelope.

## Authentication and scopes

When no Core service credential is configured, protected routes resolve to the `local-admin` principal. Keep this mode on `127.0.0.1` and do not configure cross-origin access.

When credentials exist, protected routes require `Authorization: Bearer <opaque-token>` and one explicit scope:

```text
sessions:read       sessions:write
runs:read           runs:control
events:consume      workflows:teach
workflows:govern    workflows:approve
admin               internal
```

A configured credential may also define a server-owned `subjectId` and up to 64 `user`, `workspace`, `project`, or `session` resource scopes. The client cannot replace these through request headers.

Core does not validate browser OIDC tokens. Production browser traffic must pass through a Gateway that validates the token and replaces it with a minimal opaque Core credential.

## Session and Submission idempotency

Create a session, then submit work with a caller-generated `Idempotency-Key`:

```bash
curl -fsS -X POST http://127.0.0.1:3100/api/v1/sessions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-session-001' \
  -d '{"title":"API example"}'

curl -fsS -X POST http://127.0.0.1:3100/api/v1/sessions/SESSION_ID/submissions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-submission-001' \
  -d '{"content":"Inspect the repository and report its test status."}'
```

Session creation scopes the key to the authenticated Core principal. Its canonical body trims `title`, maps an omitted/blank title to `New workspace`, and includes `origin` when supplied. The same key and canonical body returns the original Session after retries or restart; a changed body returns `session.idempotency_conflict`. `GET /api/v1/sessions/:sessionId` validates a recovered Gateway binding.

Submission reuse with the same canonical content returns the existing submission state. Different content returns `submission.idempotency_conflict`. The optional `modelId` is advisory and excluded from idempotency semantics.

## TaskRun commands and interactions

Commands are scoped by `(principal, taskRunId, commandId)`. Core checks the durable command receipt before Attempt fencing, preserves the original structured result/error, and exposes it through POST replay and `GET /commands/:commandId`. Receipt `state` is `started`, `succeeded`, `failed`, or `outcome_unknown`; `outcome` is `accepted`, `rejected`, or `unknown`; `replayed` identifies a lookup/retry. The deprecated `status: duplicate` remains during the v39 compatibility window, but consumers must read `state`, `outcome`, `result`, and `error`.

Supported commands are `task_run.steer`, `task_run.follow_up`, `task_run.cancel`, `task_run.resume`, `task_run.compact`, `task_run.submit_user_input`, and `task_run.resolve_approval`. `steer` and `follow_up` return after the fenced control intent is durable; Runtime delivery continues asynchronously. `TaskRun.pendingInteractions` is the typed source for pending Approval and User Input UI. Gateway needs only `runs:read` and `runs:control`.

An interrupted command or Goal operation with no provable terminal receipt becomes `outcome_unknown` at restart and is never blindly re-executed. The caller must inspect the TaskRun/Goal and reconcile with a new identity if required.

## Bounded reads and artifacts

Transcript pages are ordered by durable transcript sequence. `after` is exclusive, `limit` defaults to 100 and is capped at 500; `pageInfo.nextCursor` is supplied only when `hasMore=true`. `CoreClient.getTranscriptPage()` exposes the page while `getTranscript()` walks pages for compatibility. Artifact preview is capped at 5 MiB and download at 50 MiB. Oversize content returns HTTP 413 `artifact.too_large`; unavailable content remains a 503.

The operator Console updates a Workspace title and next-TaskRun execution preferences through `PATCH /api/v1/console/sessions/:id`. `modelId` must be the configured primary or fallback model, and `reasoningEffort` must be one of `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. These preferences do not mutate an active TaskRun; each admitted TaskRun carries its own immutable execution-profile snapshot.

## Event consumption

Event consumers are durable and generation-fenced:

1. claim the `(taskRunId, consumerId)` cursor;
2. open the SSE stream with `consumerId`, `generation`, and optional `after`;
3. persist each decoded `TaskRunEvent` locally;
4. acknowledge the highest durably persisted sequence;
5. reclaim after a stale-generation conflict.

The durable acknowledged sequence is authoritative. The stream always replays from that sequence and then continues live; an optional `after` value may be equal to or behind the durable ACK but may never skip ahead of it. A client checkpoint may suppress re-applying an already hydrated event, but the client must still persist and ACK the replayed sequence. The stream sends JSON `TaskRunEvent` values in `data:` frames and a comment heartbeat every 15 seconds. A newer claim invalidates an older generation.

Replay reads events in batches of 256 and bounds the replay/live handoff buffer at 1,000 events. Backpressure or overflow closes the stream; the consumer reconnects from its durable ACK. Core v39 does not automatically prune TaskRun events or expire cursors. `settledAcknowledgedSequence` includes recoverable `blocked` and terminal failure states; `finalAcknowledgedSequence` advances only for irreversible `completed` or `cancelled`. The deprecated `terminalAcknowledgedSequence` aliases the settled boundary during the compatibility window.

Projection-critical events use per-type payload schemas. Internal Supervisor/context/runtime/control detail is projected as `diagnostic.internal` with only `sourceType`; private reasoning and arbitrary internal payloads are never copied to Channel SSE. Unknown future public event types remain ignorable and ACK-able.

## Capability discovery and Operator profile

`GET /api/v1/capabilities` returns the Core release, API/event/schema versions, command/event catalogs, typed-interaction readiness, Operator Goal readiness, current no-auto-delete retention policy, and enforced payload/stream limits. Gateway must negotiate this before taking traffic.

The stable Operator allowlist in this release is Session list/get/update, TaskRun list/latest/detail, Session Inbox reads, public Transcript/Artifact reads, pending typed interactions, and the Workspace Goal routes listed above. Console/Admin routes outside this allowlist remain first-party or experimental and are not a Gateway compatibility promise. Browser credentials never enter Core; Gateway replaces them with a minimum-scope opaque service credential.

## CORS

`TAGENT_CORS_ALLOWED_ORIGINS` is an exact comma-separated allowlist of canonical HTTP(S) origins. Wildcards, credentials, paths, query strings, fragments, opaque origins, and `null` are rejected. A non-empty allowlist requires at least one Core service credential.

Preflight allows the API methods and these headers only:

```text
Authorization, Content-Type, Idempotency-Key, X-Request-Id
```

Core does not send `Access-Control-Allow-Credentials`.
