# Decision: Durable provider cooldown recovery

Status: implemented
Kind: bug-fix

## Problem

Providers can reject an otherwise valid model request with `model_cooldown` and a reset duration. Treating that response like an ordinary completion-gate failure either retries too early, loses the delay on process restart, or trips repeated-gate-state protection even though TaskRun evidence did not regress.

## Decision

`@tagent/runtime-pi` classifies `model_cooldown`, parses bounded reset durations from provider error text and HTTP `Retry-After`, and retains the existing same-Attempt retry and configured fallback order. A same-Attempt retry waits for the greater of the local exponential backoff and the provider window, and publishes that applied duration in `provider.retry.delayMs`. If the provider window does not fit the Attempt watchdog budget, Runtime does not send an early inline retry. When those bounded options are exhausted or cannot safely fit, Execution creates a provider-retry continuation whose absolute `notBefore` due time is part of the current SQLite schema.

Continuation claim and restart recovery both require `not_before <= now`. The recovery timer considers queued due times as well as expired running leases. Provider-retry continuations are excluded from repeated completion-gate stagnation detection, while manual Resume cancels the queued retry through the existing supersession path.

## Alternatives considered

**Sleep for every cooldown inside the failed Attempt.** Rejected because a provider window that does not fit the Attempt watchdog would hold in-memory ownership and disappear on process restart. A bounded inline retry remains valid only when the complete provider window fits.

**Retry every cooldown immediately.** Rejected because it violates provider guidance and can amplify throttling.

**Treat cooldown like an ordinary gate continuation.** Rejected because unchanged TaskRun evidence is expected for an external availability failure and should not be classified as stalled work.

## Verification

`tests/provider-errors.test.ts` covers cooldown and reset parsing. `tests/pi-session.test.ts` covers provider retry/fallback behavior, budget clamping, transport metadata, and a real `Retry-After` rate-limit response whose second request cannot start early. `tests/runtime.test.ts` covers delayed continuation creation and provider-retry semantics. `tests/store.test.ts` covers fresh-schema creation, fail-closed schema re-entry, due-time claim, and restart persistence. `tests/supervisor.test.ts` covers local transient classification. The full `npm test` suite passes.

## Consequences

Reset delays are bounded to one hour, and a cooldown without a usable duration defaults to sixty seconds. Provider guidance can lengthen but never shorten local backoff. A window larger than the inline watchdog budget moves recovery to the durable continuation path rather than causing an early request. The continuation limit remains authoritative, so recovery is durable but not unbounded.
