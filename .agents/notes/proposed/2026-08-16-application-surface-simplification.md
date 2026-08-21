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
- Web layout and visual styling have one canonical stylesheet owner; dead selectors, unstyled JSX classes, raw component colors, and unbounded CSS complexity are rejected.
- Focused type, lint, architecture, and behavior checks pass without requiring unrelated release-host provisioning.

**Current progress.**

- Workspace Goal transitions and evidence authorization now live behind Governance/application ports; HTTP only composes the typed transport boundary.
- SQLite still owns one connection and Unit of Work, while bounded Workspace Goal, operation-receipt, Skill, Transcript, and Session/Message repositories own their aggregate SQL.
- The Web console delegates Session lifecycle and execution preferences, presentation persistence, Session Inbox mutations, Run-view state, TaskRun input/approval/retry operations, Workspace submission orchestration, live Workspace/SSE ordering, paged conversation history, Memory annotation polling, and per-Workspace composer behavior to focused modules. Async operations carry Workspace-scoped authority; Session preferences, conversation history, and submissions reject an obsolete generation after an A→B→A switch. Memory uses bounded cursor paging and loads Cold bodies on demand.
- The former layout, design, Goal, and cascade stylesheets have converged into one bounded `app.css`. The durable color, geometry, component grammar, interaction, and visual-QA contract belongs to `docs/WEB_CONSOLE_DESIGN.md`; the executable style gate checks single-entry ownership, boot-shell parity, shared scales, complexity ceilings, and live class ownership in both JSX-to-CSS and CSS-to-JSX directions.
- Goal revision requests, evidence, decision history, lifecycle controls, and user-visible operation request IDs now stay in one disclosure-led Goal workspace. Memory correction, dispute resolution, reactivation, receipt-ID recovery, export, lifecycle filtering, and explicit Record/Topic catalog layers stay in the same catalog/detail/operations hierarchy instead of forming a duplicated text wall, second dashboard, or card wall.
- This record remains proposed because `App.tsx` still composes a large rendering surface, while `Store` still contains Submission, TaskRun-command, Evidence, and other aggregates. Those remaining extractions must preserve coherent state ownership and the single connection rather than becoming a mechanical component or repository rewrite.

## Risks

Compatibility delegators can become permanent duplicate authorities if callers are not migrated. Reducer extraction can also move code without reducing coupling, so each module must own a coherent state transition set rather than mirror component structure.
