# Decision: Attempt-scoped external-action activation

Status: implemented
Kind: bug-fix

## Problem

External-action approvals are bound to the next Attempt but are consumed by the first guarded tool call. Read-only Bash calls can reach the guard, local mutations can consume the only use before the intended external effect, and a later tool in the same approved Attempt is then rejected. Authorization is also checked before local mutation and durable tool-attempt guards, so a call that never reaches dispatch can consume authority. User-input resume creates another Attempt without a fresh external-action approval and can surface the wrong UI control.

## Decision

Treat one approved request as an activation for exactly its `approvedAttempt`, not as one tool-call allowance. Inspect authority without mutation during admission, activate it atomically after local guards and durable operation claim but immediately before tool-body dispatch, persist an append-only activation receipt, and allow later qualifying calls only within the same current Attempt. Read-only workspace tools do not need ordinary Attempt-level external authorization; tools explicitly marked `externalAction: "explicit"` always do. A user-input submission in an external-action TaskRun must transition to a real approval boundary before any new Attempt is created.

## Alternatives considered

Increasing `max_uses` would retain order-dependent exhaustion and would not identify the approved security boundary. Binding approval to a model-generated tool-call ID would be precise but is unavailable for pre-runtime approval and would force the user to approve a payload they have not yet seen. Treating approval as Run-wide would avoid repeated prompts but would let retries and changed context inherit stale authority. Activating before durable claim would leave the original consume-without-dispatch failure mode.

## Verification

`npm run check`, `npm run lint`, `git diff --check`, and the complete `npm test` suite pass. The suite covers multiple qualifying operations in one approved Attempt, later-Attempt denial, read-only observations, explicit remote effects with read-only workspace access, local guard and pre-dispatch cancellation, activation races, real approval-card creation, post-input reapproval, changed-response rejection, approval/input persistence failure recovery, HTTP command recovery, and transition/package architecture constraints. The final full run passed 1,061 tests with five environment-dependent tests skipped.

## Consequences

An activated approval remains valid after its expiry timestamp only for the already-active bound Attempt; an unactivated expired approval is denied. Existing current-Attempt approvals already stored as `consumed` with `used_count > 0` are treated as activated, avoiding upgrade-time deadlock. Every later Attempt still needs a new approval. Input submission and approval resolution now expose narrow idempotent recovery paths: changed submitted values conflict, and an approved external-action request may resume only its recorded next Attempt. The implementation reuses `approval_receipts`, so no SQLite schema, public ABI, or state-protocol migration is required.
