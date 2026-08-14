# Decision: Durable provider cooldown recovery

Status: implemented
Kind: bug-fix

## Problem

Providers can reject an otherwise valid model request with `model_cooldown` and a reset duration. Treating that response like an ordinary completion-gate failure either retries too early, loses the delay on process restart, or trips repeated-gate-state protection even though TaskRun evidence did not regress.

## Decision

`@tagent/runtime-pi` classifies `model_cooldown`, parses bounded reset durations from provider error text and HTTP `Retry-After`, and retains the existing same-Attempt retry and configured fallback order. When those bounded options are exhausted, Execution creates a provider-retry continuation whose absolute `notBefore` due time is persisted by SQLite schema 46.

Continuation claim and restart recovery both require `not_before <= now`. The recovery timer considers queued due times as well as expired running leases. Provider-retry continuations are excluded from repeated completion-gate stagnation detection, while manual Resume cancels the queued retry through the existing supersession path.

## Alternatives considered

**Sleep inside the failed Attempt.** Rejected because the delay would hold in-memory ownership and disappear on process restart.

**Retry every cooldown immediately.** Rejected because it violates provider guidance and can amplify throttling.

**Treat cooldown like an ordinary gate continuation.** Rejected because unchanged TaskRun evidence is expected for an external availability failure and should not be classified as stalled work.

## Verification

`tests/provider-errors.test.ts` covers cooldown and reset parsing. `tests/pi-session.test.ts` covers provider retry/fallback behavior and transport metadata. `tests/runtime.test.ts` covers delayed continuation creation and provider-retry semantics. `tests/store.test.ts` covers schema-45 migration, fail-closed schema re-entry, due-time claim, and restart persistence. `tests/supervisor.test.ts` covers local transient classification. The full `npm test` suite passes.

## Consequences

SQLite advances from schema 45 to 46 and older binaries require the matching pre-upgrade backup. Reset delays are bounded to one hour, and a cooldown without a usable duration defaults to sixty seconds. The continuation limit remains authoritative, so recovery is durable but not unbounded.
