# Core API contract for external automation

Contract version: 1. This document freezes the public, channel-neutral surface used by Channel Gateway. Core never accepts channel payloads and exposes no Telegram/Feishu fields or SDK types.

## Authentication

- `GET /api/health` is unauthenticated.
- Service clients use `Authorization: Bearer <token>` configured through `TAGENT_SERVICE_CREDENTIALS`, a JSON array of `{ "token": "...", "scopes": [...] }`.
- Scopes: `sessions:read`, `sessions:write`, `runs:read`, `runs:control`, `events:consume`.
- Service credentials cannot read config/status and receive 403 when authenticated but under-scoped. Tokens are never returned by config/status APIs.

## Sessions and submissions

- `POST /api/sessions` (`sessions:write`), body `{title?, requestId?}` → Session. When requestId is supplied, repeating it durably returns the same Session; this closes the create-before-binding crash window.
- `GET /api/sessions` (`sessions:read`) → Session[].
- `POST /api/sessions/:sessionId/messages` (`sessions:write`), body `{content, requestId, modelId?}`.
  - `requestId` is stable and unique within the Session inbox.
  - Response remains backward-compatible `{item, run}` and adds `receipt`:
    `{requestId, sessionId, inboxItemId, status, runId, error, createdAt, updatedAt}`.
  - Repeating the same `(sessionId, requestId)` returns the existing item and never creates a second inbox item/Run.
  - `run` is non-null when dispatch starts immediately; otherwise the item remains queued.
- `GET /api/sessions/:sessionId/submissions/:requestId` (`sessions:read`) → the same durable receipt, including a later `runId`; 404 for an unknown Session or submission.
- `GET /api/sessions/:sessionId/run` and `/runs` (`sessions:read`) discover latest/current Runs after restart.

## Run state and control

- `GET /api/runs/:runId` (`runs:read`) returns TaskRun status, phase, checkpoint/current tool, last event sequence, plan/checks/artifacts, blocked reason and terminal timestamps.
- Terminal statuses are `completed`, `failed`, `cancelled`, `interrupted`; `blocked` is resumable only when Core accepts resume.
- `POST /api/runs/:runId/steer`, body `{content, requestId}` (`runs:control`). Control request IDs are durable and idempotent per Run.
- `POST /api/runs/:runId/cancel` and `/resume` (`runs:control`). Invalid state transitions return 409.
- Terminal assistant content is read from `GET /api/runs/:runId/transcript-view` (`runs:read`); assistant text records are ordered by transcript sequence and part index.

## Durable per-Run events

Event sequences are monotonically increasing only inside one Run.

1. `POST /api/runs/:runId/consumers/:consumerId/claim` (`events:consume`) returns `{generation, ackedSeq,...}`. A new claim fences an old generation.
2. `GET /api/runs/:runId/events?consumerId=...&generation=...&after=N` (`events:consume`) returns SSE. Core replays durable events after `max(N, ackedSeq)`, then streams live events. Heartbeats are comments.
3. Persist any derived outbox work before `POST .../ack`, body `{generation, seq}`. ACKs ahead of Core's last sequence are rejected; stale generations return 409.
4. Important lifecycle types observed in current Core include `run.started`, `tool.started`, `tool.progress`, `tool.completed`, `tool.failed`, `provider.failure`, `message.completed`, `run.completed`, `run.failed`, `run.cancelled`, `run.blocked`, and resume/continuation events. Consumers must ignore unknown event types for forward compatibility.

## Proven closure

Contract tests cover: submission receipt → durable requestId lookup → inbox item/run association; per-Run durable events and fenced ACKs; terminal Run state and transcript retrieval; scoped authentication. Gateway integration tests additionally exercise the same HTTP interface against a fake Core to prove recovery and terminal delivery semantics.

## Phase 0 gap analysis

Implemented minimal Core patches:

1. **Durable submission lookup was missing.** Existing POST idempotency was durable, but a restarted client could not retrieve the item/run by requestId without scanning. Added a channel-neutral receipt and lookup endpoint.
2. **Least-privilege service authentication was missing.** Existing Basic Auth granted the same access as the Web administrator, including settings. Added optional scoped Bearer credentials while preserving Basic Auth.

No global event feed was added: existing per-Run durable SSE plus Session submission/latest-Run discovery is sufficient for M0–M4. No provenance/platform field, SDK, Core database access, runtime access, or workspace access was added.
