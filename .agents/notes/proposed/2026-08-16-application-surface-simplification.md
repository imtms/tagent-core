# Decision: Simplify application surfaces without distributing Core

Status: proposed
Kind: simplification

## Problem

The modular monolith keeps deployment and transaction ownership simple, but several internal surfaces remain broader than their responsibilities. SQLite still exposes a large Store, Workspace Goal rules are split across persistence and HTTP composition, and the Web console root owns overlapping workspace, stream, transcript, and presentation state. These shapes make local changes harder to verify and encourage multiple state authorities.

## Proposal

Keep one process, one SQLite connection and Unit of Work, and the existing domain packages. Move domain transitions out of persistence and HTTP adapters behind typed application ports. Continue extracting Store repositories by aggregate without adding a generic command bus or network boundary. Split Web state only where one reducer or controller can become the clear authority for a related set of transitions, and keep Core Client as the single wire implementation.

## Alternatives considered

**Split into network microservices.** Rejected because it weakens local transactions and multiplies lifecycle and deployment failure modes.

**Retain broad facades as architectural documentation.** Rejected where a facade mostly forwards calls or returns weakly typed results; precise ports and aggregate ownership document the boundary more reliably.

**Perform one mechanical mega-rewrite.** Rejected because the changes cross persistence, HTTP, and UI state. Each extraction should preserve behavior and be independently testable.

## Acceptance criteria

- Workspace Goal state transitions and evidence rules live in Governance/application code rather than SQLite repositories or route composition.
- HTTP Goal routes consume a narrow typed port and do not construct domain workflows.
- Store retains connection and transaction ownership but delegates aggregate implementations to bounded repositories.
- `App.tsx` delegates workspace/session/inbox, run/stream/transcript, and presentation/preferences transitions to testable state modules.
- Stream snapshots and SSE deltas have one explicit ordering authority.
- Memory administration uses cursor paging and loads Cold bodies on demand.
- Duplicate legacy CSS selectors are removed or isolated by explicit cascade layers.
- Focused type, lint, architecture, and behavior checks pass without requiring unrelated release-host provisioning.

Current implementation: shipped slices now move Workspace Goal transitions and evidence authorization into Governance/application code, route every Goal workflow through a typed Core application port, and keep HTTP as transport composition. SQLite owns the connection and Unit of Work while bounded Workspace Goal, Workspace Goal operation-receipt, Skill, Transcript, and Session/Message repositories own their aggregate SQL.

The Web console now pages Memory records and topic descriptors with bounded keyset cursors, loads Cold bodies and out-of-page recall cards on demand, isolates legacy/design/feature CSS with explicit cascade layers, and delegates presentation persistence, Session Inbox mutations, Run-view state transitions, plus live Workspace/SSE ordering to focused modules. Memory overview, observability, recall, and catalog rendering are separated from the panel's data orchestration. The Inbox controller rejects mutation responses after a Workspace switch. The live coordinator rejects stale same-session generations, treats recent SSE activity as authoritative, pauses polling while hidden, and permits full snapshot recovery only after stream staleness or disconnect.

This record remains proposed because `App.tsx` still owns the detailed SSE orchestration and a large rendering surface, while `Store` still contains Submission, TaskRun-command, Evidence, and other aggregates that should be extracted incrementally. Those remaining extractions should preserve the current single connection and avoid a mechanical reducer or repository rewrite.

## Risks

Compatibility delegators can become permanent duplicate authorities if callers are not migrated. Reducer extraction can also move code without reducing coupling, so each module must own a coherent state transition set rather than mirror component structure.
