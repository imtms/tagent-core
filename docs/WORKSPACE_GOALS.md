# Workspace Goals

Workspace Goals are the durable, Workspace-level direction above TaskRun. A Goal describes the long-term outcome, scope, non-goals and completion criteria; an approved Goal Roadmap breaks that direction into bounded TaskRun-sized items. TaskRun remains the only execution unit: Goals do not add another agent loop, background controller or automatic completion path.

## Execution model

```text
Goal definition
  -> user approval
  -> one initial Roadmap draft (LLM or manual)
  -> user edits and approves a Roadmap revision/slice
  -> approved Roadmap items launch bounded TaskRuns
  -> existing Supervisor review maps actual receipts to Goal criteria
  -> all required criteria have valid evidence
  -> explicit user confirmation closes the Goal
```

At most one Goal in a Workspace may be `active` or `ready_to_close`. This makes the direction attached to a new TaskRun unambiguous.

There are two Goal-guidance modes:

| TaskRun source | Attached Goal context | Responsibility |
| --- | --- | --- |
| User starts ordinary work in the Workspace | Immutable snapshot of the active Goal definition: title, outcome, scope, non-goals and criteria | Use the Goal as direction. The Run keeps its own contract and is not required to complete the Roadmap or every Goal criterion. |
| User starts an approved Roadmap item | Goal definition plus only the selected Roadmap item and its mapped criterion keys | Execute that bounded item. Mapped Goal criteria are added to the TaskRun acceptance criteria and may receive evidence from this Run. |

An ordinary manually started Workspace TaskRun is automatically attached before its first Attempt starts. There is no manual run-link endpoint and no best-effort attachment after execution has begun. If the Goal was `ready_to_close`, starting more guided work returns it to `active` until evidence is re-evaluated. Ordinary Goal direction does not by itself raise an exact or semantic TaskRun to `workspace_mutation`; Core raises policy only for an approved Roadmap Run or when the current Attempt actually observes a mutation-capable operation.

Roadmap launches persist their Goal authorization on the Supervisor Inbox item before dispatch. The Inbox content, routing analysis, execution policy, Goal/revision, selected item and criterion slice form one canonical idempotency binding. Reusing a request ID with any different field conflicts. A linked Goal Inbox item is immutable through generic edit, merge, delete, defer, duplicate and route operations; Goal-specific lifecycle logic owns it.

Claiming the Inbox item, creating the Run, attaching the immutable Goal snapshot and exposing the started item share one SQLite transaction. An idempotent replay validates the canonical Inbox payload and durable Goal link and repairs an interrupted attachment when possible. Authorization failure leaves a failed, non-retryable Run, never a runnable ordinary Run. Startup reconciliation repairs a missing Inbox-to-Run attachment and replays idempotent terminal projections; an internal Roadmap Run that still lacks durable authorization fails closed.

## Goal Roadmap

After the definition is approved, the Console can request an initial Roadmap draft from the configured lightweight model. Generation has deliberately bounded cost:

- every request requires a stable `requestId` and Core durably claims it before the provider call;
- replay of the same request returns its original receipt/result and never calls the model again;
- a process interruption with no provable result becomes `outcome_unknown` and requires Goal inspection, not automatic regeneration;
- concurrent requests for the same Goal share one in-flight provider call;
- the provider receives Goal data as untrusted user content and must return JSON;
- Core accepts only 2–8 bounded items with stable `snake_case` IDs;
- every item must map to at least one known Goal criterion and all required criteria must be covered;
- there is no schema-repair LLM call and no same-provider retry/fallback;
- if the Goal changes while the provider is running, the late result is discarded;
- after a draft has been stored, generation cannot be called again. Further changes create user-edited immutable revisions.

Users may also create the initial Roadmap manually. A Roadmap revision contains a summary and items with a concrete outcome, verification instruction and criterion mapping. The user can edit the draft and approve a non-empty subset of its items. Only that exact approved revision and slice can launch Roadmap TaskRuns.

Revising the Goal definition invalidates both definition and Roadmap approval. Revising only the Roadmap invalidates Roadmap approval. Old decisions remain in the audit history but never authorize a newer revision. Goal and Roadmap revisions are content-hashed and immutable once stored.

## Lifecycle

```text
draft
  -> approve Goal definition -> active
  -> create/generate, edit and approve Goal Roadmap
  -> launch approved Roadmap items as TaskRuns
  -> collect criterion evidence at TaskRun terminal checkpoints
  -> ready_to_close
  -> explicit user close -> completed

active <-> paused
active or ready_to_close -> cancelled
```

An active guided TaskRun prevents Goal pause, revision and cancellation so its immutable execution contract cannot diverge from the Goal state. Queued or claimed approved Roadmap work provides the same protection before a Run exists. A paused Goal does not guide newly started Workspace TaskRuns. Approval and lifecycle decisions must bind to the currently applicable immutable revision. `completed` and `cancelled` are terminal.

Roadmap progress is durable and projected as `unapproved`, `pending`, `running`, `completed` or `blocked`, together with the underlying `runStatus` and a derived `retryable` flag. The same item cannot be launched again while it already has queued, running or completed work. A `failed` or `cancelled` Run makes the item explicitly retryable; a `blocked` or `interrupted` Run is not duplicated and must be opened, resolved and resumed. Delayed outcomes from older Runs cannot replace the newer owner of an item.

## Gate and evidence model

Goal verification reuses the TaskRun's existing semantic Supervisor review. It does not add a second Goal-verifier LLM call:

1. A Roadmap TaskRun adds only its mapped Goal criterion prompts to the normal TaskRun acceptance criteria.
2. At a terminal checkpoint, the existing Supervisor call returns criterion-level `covered`, `unsupported`, `contradicted` or `blocked` coverage and cites only supplied evidence references.
3. Core reads only evaluations with `evaluator='llm'` and maps `covered` or `contradicted` results back to the corresponding Goal criteria.
4. Core independently resolves every cited Check, Artifact or Operation against the linked Run. Invalid, stale or fabricated references are ignored.

Checks are trusted only when bound to a successful current-Attempt Bash receipt with the same command and exit code zero. Operations must be successful current-Attempt receipts. Inline TaskRun Artifacts must originate in the current Attempt; externally durable Artifact content must remain readable, and receipt-backed Artifacts require a successful current-Attempt receipt. Evidence stores a Core-computed digest that includes Attempt identity; later receipt, content, check or Attempt changes dynamically make it stale.

Blocked TaskRuns can still contribute genuine partial or contradictory evidence. For each criterion, the newest non-stale evidence link is decisive: a newer valid result can resolve an older contradiction, while a newer contradiction revokes earlier validity. `stale` and currently decisive `contradicted` evidence never count toward closure. A Goal reaches `ready_to_close` only when every required criterion has decisive valid evidence, no guided Run remains active and the current Roadmap revision has an active approval. Completion policy is always `user_confirm`, so Core never closes a Goal automatically.

There is no Goal polling loop. TaskRun finalization and launch-failure transitions update Roadmap progress and harvest evidence. Reads deterministically recalculate evidence freshness, progress, status and one `nextAction` without calling an LLM.

## Console API

The first-party Web Console uses these operator routes:

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

These routes are the Workspace Goal subset of the stable Operator profile, not Channel message endpoints. They require `sessions:read` or `sessions:write` and use standard v1 envelopes. Historical `/plans`, `/run-links` and `/evidence` routes are intentionally absent and return 404; callers cannot bypass automatic attachment or Supervisor/Core evidence validation.

Every write requires a stable request ID. Definition/Roadmap revision and generation operations use `workspace_goal_operation_receipts`; Goal creation, decisions and TaskRun admission retain their existing durable identities. Reusing an identity with the same canonical payload returns the original result; different content is `workspace_goal.idempotency_conflict`. The operation GET exposes recovery state without another LLM call.

Goal reads expose Roadmap `runStatus`/`retryable` and may include `nextAction.taskRunId` when the Run needing attention no longer owns `currentRunId`. State, stale-revision, pending-work and idempotency conflicts use HTTP 409 rather than being flattened into validation errors.

## Persistence

The current SQLite schema stores Goal execution linkage and Gateway operation receipts in:

```text
workspace_goal_run_links.link_mode
workspace_goal_inbox_links
workspace_goal_roadmap_item_progress
workspace_goal_operation_receipts
```

Roadmap revision kind, decision kind, and linkage columns use current `roadmap` terminology. Goal operation receipts bind request IDs to canonical payload hashes and preserve result/error or `outcome_unknown` recovery state. Core 0.8 accepts an empty database or the exact legacy/current `tagent-core/0.8` shape and migrates it monotonically to revision 2.

## Explicit non-goals

Workspace Goals do not add:

- Planning, Implementation, Verification, Repair, Reviewer, Observer or Reflector agent roles;
- an automatic Goal-to-TaskRun successor loop;
- a background Goal controller or polling worker;
- a separate Goal Supervisor or evidence-model call;
- automatic Goal completion;
- generic RBAC or a new capability platform.
