# Workspace Goals

Workspace Goals add a lightweight, durable long-term outcome layer above the existing TaskRun runtime. TaskRun remains the only execution unit: Goal operations do not create a second agent loop, background controller, automatic successor, or automatic completion path.

## User model

A Goal answers four questions:

1. What long-term outcome should this Workspace reach?
2. What is explicitly in or out of scope?
3. Which bounded plan items are approved now?
4. Which existing TaskRun evidence supports closure?

The Web Console exposes Goals from the Workspace toolbar. Users can create a draft, revise and approve its definition, author a plan, approve a non-empty subset of plan items, inspect linked TaskRuns and evidence, pause/resume/cancel, and explicitly close a Goal after every required criterion has valid evidence.

## Lifecycle

```text
draft
  -> approve definition -> active
  -> add/revise plan -> review plan
  -> approve selected plan items
  -> manually run and link bounded TaskRuns
  -> link existing Check / Artifact / Operation evidence
  -> ready_to_close
  -> explicit user close -> completed

active <-> paused
any non-terminal state -> cancelled
```

Definition and plan revisions are immutable and content-hashed. A new revision invalidates the corresponding prior approval. Plan approval is partial: only the selected item IDs are approved, and a TaskRun link cannot claim items outside that slice.

## Evidence rules

Criterion progress reuses current durable execution facts rather than creating a parallel verifier runtime:

- evidence must come from an existing TaskRun already linked to the Goal;
- Goal, TaskRun and Workspace identities must match;
- Check evidence must be passed, non-stale and contain evidence text;
- Artifact evidence must reference an existing Artifact on that Run;
- Operation evidence must reference a succeeded Operation;
- evidence is bound to the active Goal definition revision and criterion key;
- `stale` and `contradicted` evidence do not support closure.

A Goal becomes `ready_to_close` only when every required criterion has valid evidence. Completion policy is `user_confirm`, so Core never closes the Goal automatically.

## Deterministic next action

Goal reads calculate one `nextAction` without an LLM or background worker:

- review the Goal definition;
- create or review the plan;
- view the current TaskRun;
- manually run the next approved item;
- resolve stale/contradicted evidence;
- resume a paused Goal;
- review evidence and close.

Goal list/detail reads and next-action calculation do not invoke the provider. Ordinary TaskRuns do not query the Goal repository.

## Console API

The first-party Web Console uses these operator routes:

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

They are Console projections, not a Gateway/channel contract. They require the existing `sessions:read` or `sessions:write` scopes and use the standard v1 success/error envelopes.

## Persistence and upgrade

SQLite schema 36 adds:

```text
workspace_goals
workspace_goal_requests
workspace_goal_revisions
workspace_goal_decisions
workspace_goal_run_links
workspace_goal_evidence_links
```

The migration from schema 34 is additive. Existing TaskRuns are not backfilled into Goals. Stop Core and back up SQLite with WAL/SHM before upgrading; binaries that only understand schema 34 must not open the migrated database.

## Explicit non-goals

This release does not add:

- Planning, Implementation, Verification, Repair, Reviewer, Observer or Reflector agent roles;
- automatic Goal-to-TaskRun conversion or successor execution;
- a background Goal controller or polling worker;
- an independent Goal recovery engine;
- generic RBAC or a new capability platform;
- automatic Goal completion.

## Reliability boundaries added in schema 36

- Goal decisions use a caller request ID plus a canonical payload hash. Repeating the same request is idempotent; reusing it with a different approved slice is rejected.
- Completed and cancelled Goals are terminal and cannot be resumed, paused, re-approved, revised, or given new evidence.
- Evidence digests are computed by Core from the referenced Check, Artifact, or Operation. Goal reads re-evaluate freshness, so stale Checks or changed receipts remove completion credit and return `ready_to_close` Goals to `active`.
- A TaskRun cannot be attached to a Goal after a mutating operation has started. Once attached, write/edit/patch/bash are checked both before the runtime tool call and again inside the local Workspace tool adapter against the active approved Plan slice.
- Ordinary TaskRuns without a Goal link retain their existing behavior and do not pay for Goal lookups beyond one indexed guard query at mutation time.
