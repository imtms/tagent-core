# API v1

## Contract source

All supported Core HTTP endpoints use `/api/v1`. `@tagent/abi` is the wire-contract source of truth; `@tagent/core-client` validates requests, responses, SSE events, and errors against that ABI.

Core is API-only. Unversioned paths such as `/api/health`, `/api/sessions`, `/api/runs/*`, and `/api/memory/*` are removed and return 404. Core does not serve static files or an SPA fallback.

## Route surfaces

| Surface | Prefix/examples | Purpose |
| --- | --- | --- |
| Public | `GET /api/v1/health` | process and writer readiness; no credential required |
| Channel | `/api/v1/sessions`, `/api/v1/task-runs/*` | durable submission, TaskRun reads and commands, transcript, artifacts, event consumers |
| Operator Read | `/api/v1/operator/*` | stable Gateway Session discovery and per-Session TaskRun history |
| Capability profiles | `/api/v1/capability-profiles`, declared Operator/Admin routes | independently negotiated Gateway feature contracts |
| Console | `/api/v1/console/*` | operator projections and controls used by the Web Console |
| Admin | `/api/v1/admin/*` | configuration, Memory, and operation receipts |
| Internal | `/api/v1/internal/*` | reserved trusted surface; undeclared routes return 404 |

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
GET  /api/v1/task-runs/:taskRunId/artifacts?after=OFFSET&limit=100
GET  /api/v1/task-runs/:taskRunId/artifacts/:artifactId/content
POST /api/v1/task-runs/:taskRunId/event-consumers/:consumerId/claim
GET  /api/v1/task-runs/:taskRunId/events
POST /api/v1/task-runs/:taskRunId/event-consumers/:consumerId/ack
GET  /api/v1/capabilities
```

Use the exported schemas for the complete route payload inventory. The Web Console uses the same stable Channel transcript route as every other client; there is no Console-only transcript projection.

Submission bodies and `task_run.steer`/`task_run.follow_up` command content are non-empty and limited to 200,000 characters. The first-party Console message, Inbox-edit and steer routes enforce the same limit; the application and SQLite persistence boundaries recheck it so alternate in-process callers cannot bypass the cap.

### Operator Read routes

The independently versioned `operator.read.v1` profile adds stable authority reads without changing the closed Operator 1.0 allowlist:

```text
GET /api/v1/operator/capabilities
GET /api/v1/operator/sessions?cursor=OPAQUE&limit=50
GET /api/v1/operator/sessions/:sessionId/task-runs?cursor=OPAQUE&limit=50
GET /api/v1/operator/sessions/:sessionId/task-runs/latest
```

Session inventory requires `sessions:read`; nested TaskRun reads require both `sessions:read` and `runs:read`. Both lists default to 50 and cap at 200. They use immutable `(createdAt DESC, id DESC)` order with snapshot membership and read-committed values. The latest route uses `(updatedAt DESC, id DESC)`, returns `data: null` for an existing empty Session and `404 session.not_found` when the Session is absent. Discover the profile through `apiVersions`, then negotiate its exact independent contract at `/api/v1/operator/capabilities`. See [OPERATOR_READ_API.md](OPERATOR_READ_API.md).

### Gateway capability profiles

The full-feature Gateway contract is discovered independently of the base capabilities response:

```text
GET /api/v1/capability-profiles
GET /api/v1/capability-profiles/:profileId
```

The registry contains exactly these profile `1.0` identities:

- `operator.session-settings.v1`
- `operator.session-inbox.v1`
- `operator.context-manifest.v1`
- `operator.skills.v1`
- `admin.memory.v1`

Each summary is evaluated for the authenticated Core principal and reports available endpoint IDs and missing service scopes. Each detail document owns the exact methods/paths, required service and resource scopes, opaque-cursor limits, retention, compatibility and write-recovery semantics. Gateway must not infer availability from another principal's document or call undeclared Console/Admin routes.

Synchronous resource mutations require `Idempotency-Key` and an `If-Match: "rN"` ETag. The first canonical payload, complete public result projection, and ETag source are retained for exact replay. Core resolves that receipt before mutable deployment validation, live readback, Router analysis, or filesystem staging; a changed payload returns `409 idempotency.conflict`, and a stale revision returns `409 concurrency.conflict` with the current ETag. Asynchronous or externally observable mutations require `Idempotency-Key` and return a durable operation receipt. Recover those receipts at `/api/v1/operator/operations/:requestId` or `/api/v1/admin/operations/:requestId`; `outcome_unknown` requires reconciliation and is never permission for automatic replay.

Profile list cursors freeze membership with immutable creation order keys while returning current public projections. Updating an unread item cannot move it past the cursor. Memory pages query storage with `limit + 1`; the 200-item HTTP maximum is a per-page bound, not a 500-item collection cap.

Session Inbox update, reorder, decision, merge, and delete operations exist only through the declared `operator.session-inbox.v1` profile endpoints. They always use the profile's idempotency receipt, resource scope, and collection-revision checks; Core does not expose a parallel unreceipted application mutation surface.

Optional `X-TAgent-Delegated-Actor` and `X-TAgent-Delegated-Request-Id` headers carry Gateway provenance but grant no authority. Core audits them separately from the authenticated service principal and granted scopes. Public Settings/Inbox/Context/Skill/Memory DTOs are ABI-owned projections and intentionally omit private paths, prompts, arbitrary metadata, tool arguments and internal evidence. See [GATEWAY_PROFILE_COMPATIBILITY.md](GATEWAY_PROFILE_COMPATIBILITY.md) and [GATEWAY_HANDOFF_STATUS.md](GATEWAY_HANDOFF_STATUS.md).

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

These routes are the Workspace Goal subset of Operator profile 1.0. They use `sessions:read` or `sessions:write`, standard v1 envelopes and Console Goal ABI schemas. Every Goal write requires a stable `requestId`. Definition/Roadmap edits and LLM Roadmap generation use durable operation receipts; `operations/:requestId` exposes `started`, `succeeded`, `failed`, or `outcome_unknown`. A repeated generation request never invokes the model again. Reusing any Goal identity with a different canonical payload returns HTTP 409 `workspace_goal.idempotency_conflict`; stale revisions, invalid lifecycle transitions, pending Roadmap work and competing Runs also return a non-retryable 409 Goal error.

After user editing and approval, `task-runs` starts an approved Roadmap item through normal admission. Ordinary user-started TaskRuns in the Workspace automatically receive the unique active Goal definition as immutable direction. Goal detail and summary `nextAction` may include `taskRunId` when the user must open a specific Run. Each Roadmap progress entry includes its Goal-level `status`, underlying nullable `runStatus`, `runId` and `retryable`: `failed`/`cancelled` work can be retried, while `blocked`/`interrupted` work must be resumed or resolved in the original Run. `/plans`, `/run-links` and `/evidence` are removed and return 404.

`@tagent/core-client` covers Goal list/get/create, definition revision, Roadmap revision/generation, operation lookup, decisions and TaskRun start. The exact stable set is returned by `GET /api/v1/capabilities`; broader Console routes are not implicitly promoted. See [WORKSPACE_GOALS.md](WORKSPACE_GOALS.md) and [GATEWAY_HANDOFF_STATUS.md](GATEWAY_HANDOFF_STATUS.md).

### Skill Console routes

The first-party Web Console manages a shared Skill catalog and replaces the Skill references for an individual Workspace:

```text
GET    /api/v1/console/skills
POST   /api/v1/console/skills
GET    /api/v1/console/skills/:id
PATCH  /api/v1/console/skills/:id
DELETE /api/v1/console/skills/:id
GET    /api/v1/console/skills/:id/revisions
GET    /api/v1/console/workspaces/:id/skills
PUT    /api/v1/console/workspaces/:id/skills
```

Reads require `sessions:read`; catalog and reference mutations require `sessions:write`. Upload uses bounded JSON `{ filename, contentBase64 }` with a 12 MiB HTTP body limit and an 8 MiB decoded source-archive limit. `PATCH` creates a new immutable revision from `{ name, description, content, disableModelInvocation? }`; Workspace `PUT` atomically replaces its references from `{ skillIds }` (maximum 32). Edits automatically become the revision frozen by future TaskRuns in every referencing Workspace. Deletion removes catalog metadata and all references while existing TaskRun snapshots remain self-contained. These Console routes are first-party and are not part of the stable Gateway Operator profile.

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

### Structured tool failures

Failed tool transcript items and `tool.completed`/`tool.failed` events may include an additive `error` object while retaining the existing readable result/reason and `isError` fields:

```json
{
  "name": "ToolExecutionError",
  "code": "ABORTED_BEFORE_DISPATCH",
  "message": "Run was cancelled before tool dispatch"
}
```

The closed code set is `ABORTED_BEFORE_DISPATCH`, `ABORTED`, `TIMEOUT`, `PATH_REJECTED`, `STALE_STATE`, `PRECONDITION_FAILED`, `INVALID_ARGUMENT`, `NOT_AUTHORIZED`, and `UNKNOWN`. Consumers should route by `code`, not parse `message`. The field is present only for failed tool results with structured error identity; `ABORTED_BEFORE_DISPATCH` means the tool body was not invoked, while `ABORTED` means effects may have started and must be reconciled through the durable receipt/state model.

## Authentication and scopes

When no Core service credential is configured, protected routes resolve to the `local-admin` principal. Keep this mode on `127.0.0.1` and do not configure cross-origin access.

When credentials exist, protected routes require `Authorization: Bearer <opaque-token>` and one or more explicit scopes:

```text
sessions:read       sessions:write
runs:read           runs:control
events:consume
admin               internal
operator:session-settings:read   operator:session-settings:write
operator:inbox:read              operator:inbox:write
operator:inbox:control           operator:context-manifests:read
operator:skills:read             operator:skills:write
admin:memory:read                admin:memory:write
admin:operations:read
```

A configured credential may also define a server-owned `subjectId` and up to 64 `user`, `workspace`, `project`, or `session` resource scopes. The client cannot replace these through request headers.

Every concrete Session or TaskRun Channel, Operator Read, or first-party Console request must also match one of those configured resource scopes. Core resolves a TaskRun to its owning Session before reads, controls, receipt claims, event-consumer changes, acknowledgements, or SSE response takeover, and filters Operator Session discovery to authorized identifiers. `workspace:<session-id>` and `session:<session-id>` both authorize that Session; `workspace:*` and `session:*` are explicit type-scoped wildcards. A configured credential with no matching resource grant is denied. `POST /api/v1/sessions` requires a Session/Workspace wildcard grant, while resource-neutral capability negotiation requires only its documented service scope. The credential-free loopback `local-admin` mode is unchanged.

Memory admin requests apply the same exact-type wildcard rule: for example, `workspace:*` authorizes a requested concrete Workspace Memory scope but does not authorize a Session, Project, or User scope. Callers cannot use a wildcard of another resource type to widen access.

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
  -d '{"content":"Inspect the repository and report its test status.","gateProfile":"relaxed"}'
```

Session creation scopes the key to the authenticated Core principal. Its canonical body trims `title`, maps an omitted/blank title to `New workspace`, and includes `origin` when supplied. The same key and canonical body returns the original Session after retries or restart; a changed body returns `session.idempotency_conflict`. `GET /api/v1/sessions/:sessionId` validates a recovered Gateway binding.

Submission reuse with the same canonical content, optional `gateProfile` (`off`, `relaxed`, or `strict`) and `origin` returns the existing submission state and its first audit chain. Different canonical content, Gate profile or provenance returns `submission.idempotency_conflict`, because the Gate profile changes execution semantics. An omitted profile defaults conservatively to `strict`.

### Gateway provenance

`GatewayProvenanceSchema` is channel-neutral and never grants authority. Session creation, Submission and TaskRun commands accept it. The current schema persists the Submission's first Core principal and canonical provenance in `submission_audit_receipts`; Submission and command receipts expose `{ principalId, origin }` without leaking raw channel payloads. Authentication and resource scope always come from the configured Core credential, never from provenance.

## TaskRun commands and interactions

Commands are scoped by `(principal, taskRunId, commandId)`. Core checks the durable command receipt before Attempt fencing, preserves the original structured result/error, and exposes it through POST replay and `GET /commands/:commandId`. Receipt `state` is `started`, `succeeded`, `failed`, or `outcome_unknown`; `outcome` is `accepted`, `rejected`, or `unknown`; `replayed` identifies a lookup/retry.

Supported commands are `task_run.steer`, `task_run.follow_up`, `task_run.cancel`, `task_run.resume`, `task_run.compact`, `task_run.submit_user_input`, and `task_run.resolve_approval`. `steer` and `follow_up` return after the fenced control intent is durable; Runtime delivery continues asynchronously. `TaskRun.pendingInteractions` is the typed source for pending Approval and User Input UI. Gateway needs only `runs:read` and `runs:control`.

An interrupted command or Goal operation with no provable terminal receipt becomes `outcome_unknown` at restart and is never blindly re-executed. The caller must inspect the TaskRun/Goal and reconcile with a new identity if required.

## Bounded reads and artifacts

Transcript pages are ordered by durable transcript sequence. `after` is exclusive, `limit` defaults to 100 and is capped at 500; `pageInfo.nextCursor` is supplied only when `hasMore=true`. Tool-result hydration may consult an earlier assistant tool-call source, but supplemental context never escapes the requested exclusive lower bound; a durable page may therefore contain no projected items. Clients must follow `pageInfo.nextCursor` until `hasMore=false` and must not treat `TaskRun.transcriptCount` as consumed before those pages have been merged. `CoreClient.getTranscriptPage()` exposes the bounded page. The unified response contains persisted model reasoning, complete tool arguments, and complete tool results; `runs:read` therefore grants access to execution-sensitive transcript data.

Artifact metadata is ordered by `createdAt` then `id`. Its offset cursor `after` defaults to 0, `limit` defaults to 100 and is capped at 200; `CoreClient.getArtifactsPage()` is the client method. Artifact preview is capped at 5 MiB and download at 50 MiB. Oversize content returns HTTP 413 `artifact.too_large`; unavailable content remains a 503. Interaction history uses the same default/max 100/200 bounded offset-page shape.

The operator Console updates a Workspace title and next-TaskRun execution preferences through `PATCH /api/v1/console/sessions/:id`. `modelId` must be the configured primary or fallback model, and `reasoningEffort` must be one of `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. These preferences do not mutate an active TaskRun; each admitted TaskRun carries its own immutable execution-profile snapshot.

## Event consumption

Event consumers are durable and generation-fenced:

1. claim the `(taskRunId, consumerId)` cursor;
2. open the SSE stream with `consumerId`, `generation`, and optional `after`;
3. persist each decoded `TaskRunEvent` locally;
4. acknowledge the highest durably persisted sequence;
5. reclaim after a stale-generation conflict.

The durable acknowledged sequence is authoritative. The stream always replays from that sequence and then continues live; an optional `after` value may be equal to or behind the durable ACK but may never skip ahead of it. A client checkpoint may suppress re-applying an already hydrated event, but the client must still persist and ACK the replayed sequence. The stream sends JSON `TaskRunEvent` values in `data:` frames and a comment heartbeat every 15 seconds. A newer claim invalidates an older generation.

Replay reads events in batches of 256 and bounds the replay/live handoff buffer at 1,000 events. Backpressure or overflow closes the stream; the consumer reconnects from its durable ACK. Core does not automatically prune TaskRun events or expire cursors. `settledAcknowledgedSequence` includes recoverable `blocked` and terminal failure states; `finalAcknowledgedSequence` advances only for irreversible `completed` or `cancelled`.

Projection-critical events use per-type payload schemas and one canonical fixture per catalog member. Internal Supervisor/context/runtime/control detail is projected as `diagnostic.internal` with only `sourceType`; private reasoning and arbitrary internal payloads are never copied to Channel SSE. Unknown future public event types remain ignorable and ACK-able. `task_run.waiting_input` carries the public User Input request. The typed interaction read model is authoritative for the complete lifecycle, including states that do not have a dedicated public event.

## Capability discovery and Operator profile

`GET /api/v1/capabilities` returns the Core release, API/event/schema versions, command/event catalogs, typed-interaction flags, `operator.profileVersion` and exact endpoint IDs, active Approval authority/readiness, exact receipt recovery, no-auto-delete/no-cursor-expiry retention policy, and enforced payload/stream limits. It advertises `operator.read.v1` in `apiVersions`; that profile's own capabilities are returned from `GET /api/v1/operator/capabilities`, while the five full-feature profiles are returned independently from `GET /api/v1/capability-profiles`. Gateway must fail fast for each feature if any required item is absent.

Only endpoint IDs returned by their owning capability profile are stable cross-team contracts. The base Operator profile consists of the completed Channel Session/Submission/TaskRun/interaction/Transcript/Artifact/event-consumer routes and the Workspace Goal subset listed above. Operator Read owns only its four declared endpoint IDs; the full-feature registry owns only the routes in each of its five detail documents. Undeclared Console/Admin routes remain first-party or experimental and Gateway must not transparently expose them. Browser credentials never enter Core; Gateway replaces them with a minimum-scope opaque service credential. See [GATEWAY_HANDOFF_STATUS.md](GATEWAY_HANDOFF_STATUS.md) for the responsibility decision.

## CORS

`TAGENT_CORS_ALLOWED_ORIGINS` is an exact comma-separated allowlist of canonical HTTP(S) origins. Wildcards, credentials, paths, query strings, fragments, opaque origins, and `null` are rejected. A non-empty allowlist requires at least one Core service credential.

Preflight allows the API methods and these headers only:

```text
Authorization, Content-Type, Idempotency-Key, If-Match, X-Request-Id, X-TAgent-Delegated-Actor, X-TAgent-Delegated-Request-Id
```

Core exposes `Deprecation`, `ETag`, `Idempotency-Replayed`, `Link`, and `X-Request-Id` and does not send `Access-Control-Allow-Credentials`.
