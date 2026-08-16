# Decision: Cursor-stable transcript and stream delivery

Status: implemented
Kind: bug-fix

## Problem

Transcript tool-result hydration currently changes an item whose public sequence belongs to the earlier assistant tool call. An exclusive cursor that already consumed that sequence cannot observe the later status/result change. The SSE route also records HTTP backpressure without pausing replay or bounding live writes, so a slow consumer can grow the response buffer without limit. The first-party Web Console shares a durable consumer identity across tabs, causing generation fencing between independent readers.

## Decision

Make every observable Transcript change carry the durable sequence that caused that change. A hydrated completed/failed tool item uses the tool-result row sequence while retaining the tool-call identity and arguments; pending calls keep the assistant row sequence. Clients merge tool items by `toolCallId`, so a later result replaces the pending projection. Add a regression that reads the pending call, appends the result, and proves an exclusive delta updates it.

Serialize SSE writes through a bounded backpressure-aware pump. Replay waits for `drain`; live delivery uses a bounded queue and closes the stream on overflow so durable replay can resume from the last ACK. Give each Web tab its own consumer identity while retaining it across reloads in that tab.

## Alternatives considered

**Refetch the entire transcript after every tool result.** This hides the cursor defect at quadratic network and projection cost and leaves non-Web clients inconsistent.

**Add a second mutable projection endpoint.** This duplicates the unified transcript contract and recreates the removed Console-only authority.

**Ignore `write()` backpressure because events are bounded.** A TaskRun has no small total event bound and a client can remain slow indefinitely.

## Verification

- A pending tool item becomes completed through a request whose exclusive cursor is the pending item sequence.
- Transcript pagination remains monotonic and bounded, including split tool call/result pages.
- Replay stops writing until `drain`, live delivery has a tested finite queue, and overflow closes the stream.
- Two Web tabs do not claim the same consumer generation identity.
- Channel, Core Client, Web API, and documentation agree on the sequence semantics.

Completed tool projections now carry the tool-result row sequence, attempt, and timestamp; pending projections retain the call row sequence. Web merges tool projections by `toolCallId`. Fastify replay, live events, and heartbeats share a serialized `SseWritePump` that pauses for `drain`, bounds pending writes at 1,000, and closes on overflow for durable replay. Web consumer identity is stored in `sessionStorage`, making it reload-stable and tab-local.

Behavior coverage proves an exclusive cursor receives a later tool result, split pages converge, backpressure waits without closing, overflow closes deterministically, malformed streams fail closed, and two browser sessions receive independent consumer IDs.

Final validation:

- Transcript/API differential, Core Client, Web state, and SSE pump regressions pass, including pending-to-completed merge and stop-during-backpressure settlement.
- The full suite passes 1,083 tests across 109 test files; the five skipped tests are four unrelated PostgreSQL Memory cases and one external-LLM quality case.
- `npm run check`, `npm run lint`, `npm run build`, and `git diff --check` pass.

## Consequences

Completed tool items will carry the result row timestamp/sequence rather than the earlier call row timestamp/sequence. Consumers that incorrectly treated `sequence` as a permanent tool-call creation sequence must instead use `toolCallId` for identity, which is already the contract's stable call identity.
