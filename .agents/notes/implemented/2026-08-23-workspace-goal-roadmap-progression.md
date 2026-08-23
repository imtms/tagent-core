# Decision: Advance approved Workspace Goal Roadmaps serially

Status: implemented
Kind: feature

## Problem

Workspace Goal criteria describe completion of the whole Goal, but Roadmap TaskRuns previously inherited mapped Goal criteria as their own acceptance criteria. An early bounded item could therefore be forced to satisfy later-stage criteria before it could settle, preventing the remaining approved Roadmap from starting. Even when one item completed successfully, operators had to start every later item manually, leaving a recoverable gap between stages.

## Decision

Keep TaskRun settlement and Goal closure as separate authorities. A Roadmap TaskRun is gated only by its own outcome and verification; mapped Goal criteria remain non-gating evidence targets that accumulate across linked Runs. A Goal becomes ready to close only after every approved Roadmap item is complete and every required Goal criterion has decisive valid evidence.

After an operator starts one approved Roadmap item, Core serially admits the next untouched approved item in Roadmap document order when the current linked Run completes successfully. Successor admission uses the ordinary Supervisor Inbox, Goal authorization, admission, and TaskRun paths with a deterministic request identity. Failed, cancelled, blocked, interrupted, already queued or running work, changed approval, Goal pause/revision, and shutdown stop progression. Automatic progression never retries a failed stage. Startup reconciliation replays terminal outcomes and uses the same request identity to repair a missed successor admission without duplication.

## Alternatives considered

**Require every Roadmap item to satisfy all mapped Goal criteria.** Rejected because Goal-wide criteria may intentionally depend on later items and would make an early stage impossible to deliver.

**Create a background Goal agent or polling controller.** Rejected because TaskRun remains the only execution unit, terminal callbacks and startup reconciliation already provide bounded progression points, and another controller would introduce competing lifecycle authority.

**Automatically retry failed or blocked items.** Rejected because a failure may require revised scope, approval, input, or recovery in the original Run. Silent retry would weaken the existing admission and governance boundaries.

## Verification

- Workspace Goal execution tests cover successful multi-stage progression, Roadmap document ordering, deterministic recovery after a missed successor admission, and stop-on-failure behavior.
- Workspace Goal and Supervisor tests cover non-gating cumulative Goal criteria, legacy persisted contracts, evidence mapping, and the requirement that every approved Roadmap item complete before closure.
- `npm run check` and the full Vitest suite pass.

## Consequences

Operators start an approved sequence once and successful stages continue without manual gaps, while every stage remains an ordinary governed TaskRun. Goal evidence can accumulate across stages without blocking an otherwise complete bounded Run. A stopped sequence remains visible and requires explicit operator action; Core adds no implicit retry or automatic Goal closure.
