# Decision: Keep Memory lifecycle projections coherent

Status: implemented
Kind: bug-fix

## Problem

Three reversible Memory paths could leave durable projections inconsistent. Ordinary governance forced a complete Core Memory regeneration and erased unrelated human-authored text. Reconfirming a superseded single-valued fact or preference reactivated it without superseding the currently active replacement, so A→B→A left both A and B active in records, Recall, and Core Memory. Whole-Topic forget invalidated the retained published Cold revision, while restore reactivated the Topic and records but left no readable Cold page even though its immutable blob was still inside the grace period.

## Decision

Reserve forced Core Memory generation for the explicit Generate operation. Capture, maintenance, approve, correct, forget, and restore use preservation mode, which retains human-authored lines and updates only generated provenance-owned content.

When duplicate integration adds a novel source and reactivates a superseded record, rerun the same conflict predicate used for a new candidate and supersede every active conflict before persisting the merged record. This keeps single-valued fact and preference projections coherent without treating an idempotent duplicate source as a new confirmation.

Distinguish a whole-Topic tombstone from partial record deletion. Whole-Topic forget marks the Topic and records deleted but retains the current published Cold pointer/revision through the grace period; restoring that Topic makes the exact retained page readable again. If any record remains active in the Topic, record deletion leaves the Topic live and invalidates its Cold revision so restore cannot expose still-forgotten content.

## Alternatives considered

**Always rebuild Core Memory after governance.** Rejected because generated records do not own unrelated manual content and only the explicit Generate action communicates destructive rebuild intent.

**Let Recall rank two reactivated conflicts.** Rejected because active single-valued state is a lifecycle invariant; ranking cannot prevent contradictory Core projection or downstream consumers from observing both values.

**Always retain or always invalidate Cold on forget.** Rejected because unconditional invalidation breaks reversible whole-Topic deletion, while unconditional retention can reintroduce content removed from only part of a still-live Topic.

## Verification

`tests/memory-audit-regressions.test.ts` proves manual Core text survives approve, correct, and forget synchronization; A→B→A leaves only A active for both facts and preferences and projects only A through Recall/Core; a whole-Topic tombstone restores its exact retained Cold revision, while partial deletion invalidates Cold and record-only restore does not revive it. Existing Memory lifecycle, governance, capture, and issue-#25 restoration regressions remain the surrounding compatibility coverage.

## Consequences

Ordinary synchronization can no longer be used as an implicit destructive Core Memory reset; operators use explicit Generate when they want that result. Reconfirmation may update both the duplicate record and one or more active conflicts in the same capture publication. Cold storage keeps a published revision for a deleted whole Topic until normal retention purge, increasing no configured retention period and exposing it only after an authorized restore.
