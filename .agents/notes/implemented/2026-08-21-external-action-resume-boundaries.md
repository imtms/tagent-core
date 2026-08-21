# Decision: External-action resume boundaries

Status: implemented
Kind: bug-fix

## Problem

An inactive external-action TaskRun could expose ordinary Resume while `RunContextService` rejected that command with `External-action TaskRun requires an approval-bound resume`. The user therefore saw a control that could never succeed when a Supervisor failure, restart, or timeout left no pending approval. Separately, safe crash recovery could queue a Continuation for an interrupted external-action Run and advance to a new Attempt without fresh approval; the tool guard then denied the first qualifying operation. This made the issue appear intermittent and cross-Attempt. Runtime context also did not tell the model that Core had already bound approval to the current Attempt, encouraging false claims that an approval ID or token was missing.

## Decision

Treat every path from an inactive external-action Run to a new Attempt as an approval-request operation. Manual Resume creates a durable `execute_external_action` approval whose `approvedAttempt` is exactly the next ordinal and normalizes the Run to its blocked interaction boundary without advancing the Attempt; resolving that approval performs the existing fenced resume. A generic resume approval is not acceptable external authority. The same rule applies when a nominally local Task previously discovered an explicit external tool, identified by its durable approval history. Exclude those Runs from automatic crash recovery, cancel any legacy queued Continuation before claim, and publish the current Attempt's authorization status in Core-owned runtime context without exposing or accepting authority tokens from the model.

## Alternatives considered

Allowing ordinary Resume and relying on the tool guard would remain safe at the effect boundary, but would waste an Attempt and recreate the confusing late block. Automatically reusing the previous approval would violate Attempt scope. Automatically creating and approving recovery authority would remove the human checkpoint. Hiding Resume only in the Web Console would leave Gateway clients and persisted legacy Continuations incorrect. Making approval Run-wide would widen authority across retries and changed context.

## Verification

`npm ci`, lint, type/package/documentation checks, the complete production build, both dependency audits, `git diff --check`, and the deterministic compaction benchmark pass for `0.8.15`. The full local suite passes 1,070 tests in 89 files with the five PostgreSQL-only tests skipped for the tag workflow's PostgreSQL 17 gate. Regression coverage proves that manual Resume creates one replay-safe next-Attempt approval, generic approval is rejected, approval resumes blocked and current-Attempt timeout failures, historical timeouts cannot make a later ordinary failure resumable, runtime context reports current approval, dynamic external-tool history requires reapproval, safe crash recovery excludes external Runs, and legacy queued Continuations are cancelled without advancing the Attempt.

## Consequences

Clicking Resume on an inactive external-action Run now produces an approval card rather than starting Runtime. This is one additional explicit user action but makes the control honest and keeps authority narrow. Interrupted external Runs remain available for human reconciliation instead of automatic crash recovery. No public ABI, SQLite schema, Memory schema, or state-protocol migration is required; existing approval metadata and command receipts carry the new recovery state.
