# Roadmap to TAgent Core 0.2.0

TAgent Core should not move to `0.2.0` merely because several `0.1.x` features have accumulated. The minor-version boundary should represent a coherent architecture milestone: the durable Supervisor must become a trustworthy **Session / Topic / TaskRun orchestration control plane**, not only a reliable single-Run executor.

## Current position

`0.1.5 + main` provides durable Session admission, structured TaskRun contracts, progress/evidence/completion supervision, bounded continuation, explicit approvals, spawn proposals, persistent memory governance, and per-attempt Context Manifests.

The implementation is approaching the original design, but Topic orchestration, ambiguous multi-intent analysis, general capability approvals, and dependency-aware scheduling are not yet complete. Until those gates pass, releases should remain `0.1.x`.

## Required 0.2.0 gates

### 1. Explainable context assembly

- Persist one immutable Context Manifest for every Run start, resume, and continuation.
- Include selected and omitted Session/transcript messages, TaskRun contract, core memory, memory cards, Cold Topics, current prompt, reasons, token estimates, and a stable hash.
- Expose manifests through API and Web diagnostics.
- Prove that a manifest can explain a wrong or missing-context answer without reading process memory.

**Status:** foundation complete on `main`; Topic links and richer message IDs remain.

### 2. First-class Topic graph

- Durable `topics`, `message_topic_links`, `taskrun_topic_links`, and `topic_edges`.
- Many-to-many links with confidence, provenance, model/rule version, and human correction receipts.
- Merge, split, supersede, and versioned Topic summaries without changing immutable messages.
- Resume a TaskRun from a different Session using its Topic and TaskRun context.

**Status:** not complete. Memory Topics are not a substitute for Supervisor Topics.

### 3. Multi-intent Session supervision

- Deterministic safety fast paths remain authoritative.
- A schema-validated semantic classifier may propose multiple intents for ambiguous input.
- Durable policy chooses steer, context update, follow-up, independent work, or parallel proposal.
- Low-confidence or conflicting classifications require user confirmation rather than silent routing.
- Evaluation fixtures cover mixed Chinese/English inputs and adversarial ambiguity.

**Status:** deterministic `rules-v2` only.

### 4. Unified capability-policy approval

- High-risk operations are classified before execution, not only after a blocked plan/check.
- Approval receipts bind actor, capability, exact operation digest, scope, expiry, and one-time/reusable semantics.
- Resume cannot broaden an approved operation.
- Production deploy, destructive database/file actions, external writes, credential use, and public release have explicit policies and tests.

**Status:** Run and Spawn approvals exist; general operation approval is incomplete.

### 5. Dependency-aware scheduler

- Approved TaskRun graph supports dependency readiness, bounded parallelism, workspace/resource locks, cancellation propagation, and child-result aggregation.
- Scheduler state is durable and crash recoverable.
- No two Runs can mutate the same protected resource without policy authorization.

**Status:** proposal and edge foundations exist; automatic scheduler is incomplete.

### 6. Release-quality evidence

- Required SQLite migration, PostgreSQL memory, browser, restart/recovery, lease/fencing, and long-running staging E2E gates.
- Supervisor routing benchmark and Memory semantic benchmark report stable thresholds.
- No known P0/P1 correctness issue, no undocumented schema/API drift, and rollback instructions are tested.
- 3220 staging runs the release candidate across restart with real memory and provider readiness healthy.

## Version decision

The present code should remain in the `0.1.x` line. A future `0.1.6` or later may ship Context Manifest and incremental Supervisor improvements. Promote to `0.2.0` only when all six gates above are implemented and evidenced in a release audit. The defining user-visible promise of `0.2.0` should be:

> TAgent Core can explain, govern, and recover how user input becomes context and coordinated TaskRuns across Sessions and Topics.
