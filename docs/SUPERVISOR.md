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

The current deterministic semantic router uses auditable rules (`semantic-rules-v3`). It decomposes compound input into persisted objectives with timing and work-kind metadata before policy selects the durable action. It does not let an LLM directly mutate durable state.

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

The TaskRun Supervisor distinguishes the designed terminal and runtime actions:

- evidence-only completion failures -> `request_evidence` and an automatic continuation dedicated to verification;
- blocked approval/permission items -> `pause_for_approval`, a durable approval request, and no automatic continuation;
- pending durable steer/follow-up delivery at settle time -> `wait_for_runtime`;
- repeated identical successful tool operations -> bounded `steer`, not only repeated failures;
- transient provider/network attempt failures -> `start_continuation`;
- missing user parameters or non-transient runtime failures -> durable block.

These decisions are persisted with the `attempt_terminal` or `settled` trigger instead of converting every runtime exception directly to `run.failed`.

## Candidate response governance

Assistant text shown while a TaskRun is running is provisional runtime output. It is not a durable chat answer until settled review approves it.

At every assistant-message boundary the runtime emits `message.started`, which resets the durable partial checkpoint and the Web live card before accepting new deltas. This prevents a steer, retry, or continuation response from being concatenated onto an earlier draft. If completion gates reject the candidate, the service emits `message.rejected`, retains the candidate in the Run transcript for audit, and does not append it to Session chat history.

In addition to Plan, Check, evidence, progress, and non-empty delivery checks, settled review now produces criterion-by-criterion contract coverage and validates completion claims against independent Check evidence, successful Operation receipts, or published Artifacts. A short generic acknowledgement such as “received, completed” cannot finish a substantial contract merely because agent-authored state says that work passed. Auto-fixable delivery failures create a continuation whose prompt explicitly requires a complete standalone replacement addressing the original contract.

This is a deterministic, independently evidenced safety floor rather than a second free-form agent. Criterion receipts expose covered, unsupported, contradicted, and blocked outcomes; unsupported completion claims trigger continuation instead of durable delivery.

## Context Manifest

Every new Run, resume, and continuation now persists an immutable per-attempt Context Manifest. It records the required system instruction, TaskRun contract, selected and omitted Session/transcript messages, Core Memory, dynamic Memory Cards, Cold Topics, current prompt, selection reasons, token estimates, and a SHA-256 manifest hash.

The latest manifest is visible in the TaskRun panel, and the full history is available from:

```http
GET /api/runs/:id/context-manifests
```

This closes the basic explainability gap between Context Assembler decisions and durable Supervisor diagnostics. The current manifest uses derived message identities; stable Message/Transcript IDs and Supervisor Topic links are part of the 0.2 roadmap.

## Current boundary

The semantic-rules-v3 router covers high-confidence safety paths and decomposes compound requests into explicit objectives, acceptance criteria, timing, scope, and relation metadata. Durable Run approval requests and their Approve/Reject Web flow are implemented. Future versions may add a schema-validated classifier for ambiguous multi-intent input, semantic clustering beyond canonical summary equality, dedicated lightweight discussion turns, dependency-aware parallel execution, and cross-Session Topic routing.


## Design alignment audit

The current implementation covers the durable Session Inbox, high-confidence input routing, TaskRun contracts, checkpoint/settled/attempt-terminal reviews, completion/evidence/continuation gates, explicit approval receipts, and approved spawn proposals. Compared with the original Session/Topic/TaskRun design, the following remain intentionally incomplete:

- Topic is not yet a first-class cross-Session graph with message/Run links, confidence, merge, split, and correction receipts.
- Context Manifests now persist Session/transcript, TaskRun, prompt, and Memory selection. First-class Supervisor Topic links and stable cross-Session message identities remain incomplete.
- Multi-intent decomposition is deterministic and persisted, but ambiguous low-confidence classification still lacks an optional schema-validated model adjudicator and explicit user confirmation UI.
- Discussion and clarification still use a lightweight TaskRun contract rather than a dedicated conversation-only runtime.
- Parallel proposals require explicit approval and manual start; there is no dependency-aware concurrent scheduler.
- Safety approvals currently govern Supervisor pauses and spawn proposals, not every high-risk operation through one capability-policy system.

These are architectural roadmap items rather than claims of completed functionality.


The explicit promotion criteria for the next minor version are maintained in [Roadmap to 0.2.0](ROADMAP_0.2.md).
