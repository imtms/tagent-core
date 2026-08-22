# Decision: Scriptable provider wire faults

Status: implemented
Kind: testing

## Problem

Provider recovery tests mostly injected completed SDK messages or built one-off HTTP servers. They could not prove behavior for connection resets, incomplete streams, malformed SSE, empty completions, request identity, or contamination by partial failed output.

## Decision

`tests/support/wire-fault-server.ts` owns a deterministic scripted fixture for reset-before-headers, partial-SSE reset, clean EOF without `[DONE]`, malformed SSE, empty completion, HTTP 429 with `Retry-After`, and success. It records request arrival times so retry-window behavior can be asserted. A seeded selector produces repeatable randomized sequences.

OpenAI-compatible SSE transport requires the `[DONE]` sentinel, and an otherwise successful empty completion is a retryable `empty_response`. One response-disposition rule excludes failed, aborted, empty, and recoverable-overflow assistant responses as the Harness Session appends them, while retaining their failure events. Runtime does not rewind Pi storage leaves after the fact. Full-turn retries persist a new envelope while preserving an identical provider payload hash.

## Alternatives considered

**Mock only the SDK result.** Rejected because it cannot exercise socket and parser boundaries.

**Maintain a server per test.** Rejected because fault semantics and request capture drift between copies.

**Accept EOF after a finish chunk.** Rejected because a truncated connection would be indistinguishable from a complete protocol exchange.

## Verification

`tests/pi-session.test.ts` runs every fault followed by success against the real OpenAI-compatible adapter. It asserts exactly two requests, canonical body and hash identity, one durable successful assistant response, retry lifecycle events, absence of failed partial content from the active Session, second request, and transcript, no direct Session-storage access, and no rate-limit retry before the fixture's `Retry-After` window.

## Consequences

The OpenAI-compatible path is intentionally stricter about `[DONE]`. Providers that omit the sentinel despite claiming SSE compatibility are classified as incomplete and retried within the configured budget.
