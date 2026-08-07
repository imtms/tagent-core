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
POST /api/v1/sessions/:sessionId/submissions
GET  /api/v1/sessions/:sessionId/submissions/:idempotencyKey
GET  /api/v1/task-runs/:taskRunId
POST /api/v1/task-runs/:taskRunId/commands
GET  /api/v1/task-runs/:taskRunId/transcript
GET  /api/v1/task-runs/:taskRunId/artifacts
GET  /api/v1/task-runs/:taskRunId/artifacts/:artifactId/content
POST /api/v1/task-runs/:taskRunId/event-consumers/:consumerId/claim
GET  /api/v1/task-runs/:taskRunId/events
POST /api/v1/task-runs/:taskRunId/event-consumers/:consumerId/ack
```

Use the exported schemas for the complete route payload inventory. Console projections are richer than channel resources and are not a substitute for the stable channel contract.

### Workspace Goal Console routes

The first-party Web Console manages lightweight Workspace Goals through the operator surface:

```text
GET  /api/v1/console/workspaces/:workspaceId/goals
POST /api/v1/console/workspaces/:workspaceId/goals
GET  /api/v1/console/workspace-goals/:goalId
POST /api/v1/console/workspace-goals/:goalId/definition-revisions
POST /api/v1/console/workspace-goals/:goalId/plans
POST /api/v1/console/workspace-goals/:goalId/decisions
POST /api/v1/console/workspace-goals/:goalId/run-links
POST /api/v1/console/workspace-goals/:goalId/evidence
```

These routes use `sessions:read` or `sessions:write`, the standard v1 envelopes and the Console Goal ABI schemas. They do not start TaskRuns or provide an automatic Goal controller. See [WORKSPACE_GOALS.md](WORKSPACE_GOALS.md).

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

## Submission idempotency

Create a session, then submit work with a caller-generated `Idempotency-Key`:

```bash
curl -fsS -X POST http://127.0.0.1:3100/api/v1/sessions \
  -H 'Content-Type: application/json' \
  -d '{"title":"API example"}'

curl -fsS -X POST http://127.0.0.1:3100/api/v1/sessions/SESSION_ID/submissions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-submission-001' \
  -d '{"content":"Inspect the repository and report its test status."}'
```

Reusing a key with the same canonical content returns the existing submission state. Reusing it with different content returns `submission.idempotency_conflict`. The optional `modelId` is advisory and is excluded from idempotency semantics.

The operator Console updates a Workspace title and next-TaskRun execution preferences through `PATCH /api/v1/console/sessions/:id`. `modelId` must be the configured primary or fallback model, and `reasoningEffort` must be one of `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. These preferences do not mutate an active TaskRun; each admitted TaskRun carries its own immutable execution-profile snapshot.

## Event consumption

Event consumers are durable and generation-fenced:

1. claim the `(taskRunId, consumerId)` cursor;
2. open the SSE stream with `consumerId`, `generation`, and optional `after`;
3. persist each decoded `TaskRunEvent` locally;
4. acknowledge the highest durably persisted sequence;
5. reclaim after a stale-generation conflict.

The stream replays from the greater of `after` and the durable acknowledged sequence, then continues live. It sends JSON `TaskRunEvent` values in `data:` frames and a comment heartbeat every 15 seconds. A newer claim invalidates an older generation.

## CORS

`TAGENT_CORS_ALLOWED_ORIGINS` is an exact comma-separated allowlist of canonical HTTP(S) origins. Wildcards, credentials, paths, query strings, fragments, opaque origins, and `null` are rejected. A non-empty allowlist requires at least one Core service credential.

Preflight allows the API methods and these headers only:

```text
Authorization, Content-Type, Idempotency-Key, X-Request-Id
```

Core does not send `Access-Control-Allow-Credentials`.
