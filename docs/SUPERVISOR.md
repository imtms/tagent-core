# Session and TaskRun Supervisor

TAgent Core separates two durable control layers:

- **Session Input Router** understands newly admitted user input and chooses how it relates to the active TaskRun.
- **TaskRun Supervisor** reviews progress, evidence, completion gates, continuations, and explicit spawn proposals.

## Session input routing

Every composer submission is persisted with a structured analysis:

- concise `summary`;
- `intent` and target Run;
- priority and urgency;
- relation to current work;
- acceptance criteria;
- confidence, reason, and router version.

The current deterministic router uses conservative, auditable rules (`rules-v2`). It does not let an LLM directly mutate durable state.

| Input class | Durable action |
|---|---|
| stop, correction, constraint, changed path/port | steer active Run |
| parameter or evidence for current work | steer/update active context |
| explicit “after completion” work | Pi follow-up queue |
| explicit independent parallel work | spawn proposal, not automatic execution |
| independent work | prioritized queued TaskRun contract |
| question/discussion or clarification | lower-priority lightweight contract (dedicated conversation-only execution remains future work) |
| explicit postponement | durable deferred item that is not automatically dispatched |

Low-confidence input remains independent queued work. It is not silently delivered into an active Run.

## TaskRun contract

A queued item no longer copies its full raw prompt into `runs.goal`. Selection persists:

- immutable source input;
- concise goal summary;
- scope and non-goals;
- acceptance criteria;
- source Inbox IDs;
- parent/target Run and relation;
- routing reason and version.

The runtime receives this contract plus the original input. The Web task panel displays the contract and routing rationale.

## Scheduling and deduplication

Automatic selection orders eligible items by:

1. manual ordering override;
2. urgency;
3. priority;
4. stable queue position and age.

Equivalent pending summaries are deduplicated at admission. Editing re-runs classification against the active Run, and manual merge combines summaries, scopes, acceptance criteria, urgency, and priority instead of only concatenating prose. Users can still reorder, defer, delete, or run an item explicitly.

## Spawn safety

Parallel input creates a durable `SpawnProposal` and an auditable Run event. The Agent can also create a derived/follow-up proposal through `task_run.spawn_proposal` when execution discovers an independent target.

A proposed child cannot be launched directly. It must transition through explicit approval (`proposed -> approved -> spawned`), and the Web TaskRun panel exposes Approve, Reject, and Start actions. Non-parallel children additionally wait for the parent to complete.

## Attempt and settled supervision

The TaskRun Supervisor now distinguishes additional designed actions:

- evidence-only completion failures -> `request_evidence` and an automatic continuation dedicated to verification;
- blocked approval/permission items -> `pause_for_approval` without automatic continuation;
- transient provider/network attempt failures -> `start_continuation`;
- missing user parameters or non-transient runtime failures -> durable block.

These decisions are persisted with the `attempt_terminal` or `settled` trigger instead of converting every runtime exception directly to `run.failed`.

## Current boundary

The deterministic router covers the high-confidence safety and orchestration paths required for stable operation. Future versions may add a schema-validated LLM classifier for ambiguous multi-intent input, semantic clustering beyond canonical summary equality, dedicated lightweight discussion turns, dependency-aware parallel execution, and approval UI for spawn proposals.
