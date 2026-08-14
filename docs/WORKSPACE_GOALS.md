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

An ordinary manually started Workspace TaskRun is automatically attached before its first Attempt starts. There is no manual run-link endpoint and no best-effort attachment after execution has begun. If the Goal was `ready_to_close`, starting more guided work returns it to `active` until evidence is re-evaluated.

Roadmap launches persist their Goal authorization on the Supervisor Inbox item before dispatch. An idempotent replay repairs an interrupted pre-dispatch link; recovery refuses to launch an internal Roadmap submission whose durable authorization is missing, so it cannot fall back to ordinary Workspace guidance.

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

An active guided TaskRun prevents Goal pause, revision and cancellation so its immutable execution contract cannot diverge from the Goal state. A paused Goal does not guide newly started Workspace TaskRuns. `completed` and `cancelled` are terminal.

Roadmap progress is durable and projected as `unapproved`, `pending`, `running`, `completed`, `blocked` or `skipped`. The same item cannot be launched again while it already has queued, running or completed work; a recoverable blocked item can be retried explicitly.

## Gate and evidence model

Goal verification reuses the TaskRun's existing semantic Supervisor review. It does not add a second Goal-verifier LLM call:

1. A Roadmap TaskRun adds only its mapped Goal criterion prompts to the normal TaskRun acceptance criteria.
2. At a terminal checkpoint, the existing Supervisor call returns criterion-level `covered`, `unsupported`, `contradicted` or `blocked` coverage and cites only supplied evidence references.
3. Core reads only evaluations with `evaluator='llm'` and maps `covered` or `contradicted` results back to the corresponding Goal criteria.
4. Core independently resolves every cited Check, Artifact or Operation against the linked Run. Invalid, stale or fabricated references are ignored.

Checks are trusted only when bound to a successful current-Attempt Bash receipt with the same command and exit code zero. Operations must be successful current-Attempt receipts. Artifacts must contain readable durable content or be backed by a successful current-Attempt artifact receipt. Evidence stores a Core-computed digest; later receipt, content, check or Attempt changes dynamically make it stale.

Blocked TaskRuns can still contribute genuine partial or contradictory evidence. `stale` and `contradicted` evidence never count toward closure. A Goal reaches `ready_to_close` only when every required criterion has valid evidence, no guided Run remains active and the current Roadmap revision has an active approval. Completion policy is always `user_confirm`, so Core never closes a Goal automatically.

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

## Persistence and upgrade

SQLite schema 47 retains the Goal tables, schema-38 execution linkage and schema-39 Gateway operation receipts:

```text
workspace_goal_run_links.link_mode
workspace_goal_inbox_links
workspace_goal_roadmap_item_progress
workspace_goal_operation_receipts
```

The v38 → v39 migration adds Goal operation payload hashes, result/error receipts and restart recovery state. Schema 40 adds Submission audit receipts, schema 41 adds Operator Read indexes, and schema 42 durably carries the Admission execution policy through the Inbox. Schema 43 adds the Skill catalog and revisions; schema 44 replaces the original single binding with multi-Skill Workspace references; schema 45 adds Attempt request envelopes; schema 46 adds persisted continuation due-time scheduling; schema 47 adds independent Gateway profile persistence. None changes Goal semantics. Some internal SQLite columns and values retain `plan` names for forward-compatible migration of existing databases; they are not public domain or API terminology.

Migrations are forward-only. Stop Core and back up SQLite together with WAL/SHM before upgrading. A schema-46-only binary must never open a schema-47 database; rollback across this boundary requires the matching pre-upgrade database backup. See [UPGRADING.md](UPGRADING.md).

## Explicit non-goals

Workspace Goals do not add:

- Planning, Implementation, Verification, Repair, Reviewer, Observer or Reflector agent roles;
- an automatic Goal-to-TaskRun successor loop;
- a background Goal controller or polling worker;
- a separate Goal Supervisor or evidence-model call;
- automatic Goal completion;
- generic RBAC or a new capability platform.
