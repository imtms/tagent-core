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

The current deterministic router uses conservative, auditable rules. It does not let an LLM directly mutate durable state.

| Input class | Durable action |
|---|---|
| stop, correction, constraint, changed path/port | steer active Run |
| parameter or evidence for current work | steer/update active context |
| explicit “after completion” work | Pi follow-up queue |
| explicit independent parallel work | spawn proposal, not automatic execution |
| independent work | prioritized queued TaskRun contract |
| question/discussion | concise discussion TaskRun (conversation-only execution remains future work) |

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

Equivalent pending summaries are deduplicated at admission. Users can still edit, reorder, defer, merge, delete, or run an item explicitly.

## Spawn safety

Parallel input creates a durable `SpawnProposal` and an auditable Run event. It does not automatically execute the child. Existing Spawn Gate/API approval semantics remain authoritative.

## Current boundary

The deterministic router covers the high-confidence safety and orchestration paths required for stable operation. Future versions may add a schema-validated LLM classifier for ambiguous multi-intent input, semantic clustering beyond canonical summary equality, dedicated lightweight discussion turns, dependency-aware parallel execution, and approval UI for spawn proposals.
