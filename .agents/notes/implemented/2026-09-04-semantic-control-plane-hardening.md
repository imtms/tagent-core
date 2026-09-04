# Decision: Harden semantic admission, evidence, and completion control

Status: implemented
Kind: architecture

## Problem

Core already owns durable Attempt fencing, provider request envelopes, operation receipts, approval activation, Transcript history, and settlement, but several semantic control surfaces remain weaker than those execution primitives. Router prompts can exceed their configured model window and their deterministic fallback can expand background prose into unbounded objectives. Router usage is associated with an object identity that Admission replaces when it freezes a Gate profile. Tool authorization primarily inherits TaskRun-level risk even though generic Bash can perform effects that the Router did not classify. A disabled completion Gate can accept an empty provider candidate, while ordinary `write` can replace an existing file without the snapshot precondition required by `edit` and `patch`.

Planning and evidence are also too coarse for authoritative semantic completion. Required plan items are self-reported and have no objective or criterion coverage. Criterion coverage cites whole receipts or Artifacts by string ID without a Core-verified quote or selector, and bounded Supervisor projections can omit earlier evidence. Strict review converts every unsupported criterion into automatic repair even when further attempts cannot remove honest uncertainty. Context Manifests identify selected sources but do not consistently commit to the exact projected bytes, and the Agent-facing Transcript search cannot page or fetch one exact durable entry.

## Decision

Deliver the hardening in independently verified layers while retaining the modular monolith and the existing Attempt, approval, receipt, Transcript, Context Manifest, and request-envelope authorities.

1. Make admission bounded and explicit. Project Router input against the configured Router context window, persist usage in the Router result rather than a WeakMap keyed by analysis identity, cap deterministic fallback objectives and criteria, retain `merge_candidate` only as a readable legacy ABI value while preventing model routing from producing it, and route materially low-confidence intake to a durable clarification boundary instead of silently dispatching it.
2. Make tool authorization effect-aware. Extend the runtime-neutral tool policy with deterministic effects for local reads, workspace mutations, filesystem access outside the workspace, network access, process control, and external mutation. Preserve Attempt-scoped activation, but require explicit approval for any effect not proven local and contained. Treat Bash parse uncertainty as explicit rather than safe. Because Bash has no descriptor-relative containment or OS sandbox, only a narrow lexical set of path-free/current-directory, non-dereferencing observations remains approval-free; workspace code execution and generic path-reading commands require approval.
3. Add candidate and file-mutation integrity floors. No Gate profile, including `off`, may settle an empty, failed, token-truncated, or transport-incomplete candidate. Creating a new file and replacing an existing file must have distinct preconditions; replacement requires the current snapshot hash.
4. Make plans and evidence criterion-aware. Required plan items declare covered objective and criterion IDs, dependencies, Attempt attribution, and replanning reason. Required-plan dependency graphs must be acyclic. Add immutable Evidence Quotes whose selector and quoted bytes are verified by Core against a source hash and revision. A strict coverage receipt that cites `check:*` must locally cite and quote that exact check's underlying `operation:*`; prompt instructions are not an authorization boundary. Supervisor input is selected from a criterion-linked evidence manifest instead of temporal windows alone.
5. Add an explicit uncertainty decision. An operator may durably accept uncertainty for an individual criterion with actor, rationale, scope, evidence, and optional expiry. This is separate from effect approval. When the accepted uncertainty removes the final completion failure, Core re-adjudicates the already-preserved rejected Candidate in one transaction without rerunning the Agent, appends new Gates and a new decision, and completes the blocked Attempt and Run while retaining the earlier rejection history. Completion remains `completed` but exposes accepted and unresolved uncertainty in its governance ledger.
6. Complete provenance and recall. Context Manifest items commit to projected-content hashes and link to the provider request envelopes that used them. Transcript tools accept an exclusive cursor, return a next cursor, and can fetch one exact sequence for quote verification.
7. Reduce orchestration cycles only after behavior is stable. Extract approval and Run-transition application responsibilities from Admission callbacks without adding a network boundary, generic command bus, or second mutation authority.

## Alternatives considered

**Rely on stronger Router prompts.** Rejected because provider availability, context overflow, and model misclassification are expected failure modes; safety and boundedness must remain deterministic.

**Require approval for every Bash command.** Rejected because path-free output and a narrow set of current-directory, non-dereferencing observations can be classified without external authority. All generic path following, workspace code execution, and unknown effects still fail closed behind current-Attempt approval; native descriptor-relative `read`/`ls` remain the preferred contained observation path.

**Make Supervisor inspect the complete durable history.** Rejected because work would grow with Run history and conflict with bounded-hot-path decisions. Criterion-linked evidence selection and exact quote retrieval keep review bounded by relevant evidence.

**Add a new `completed_with_uncertainty` terminal state.** Rejected initially because it multiplies lifecycle and client transitions. A completed Run with an explicit accepted-uncertainty ledger preserves one terminal state while keeping the epistemic distinction visible.

**Split Router, Supervisor, or approval into services.** Rejected because local transactions, recovery, and single-writer authority are strengths of the current modular monolith.

## Verification

- Router regression coverage proves that requests stay within the configured input budget, oversized durable source remains addressable, deterministic fallback emits at most 12 objectives and 24 criteria, explicit Gate-profile replacement preserves usage, and low-confidence routing crosses a durable clarification boundary.
- Tool-policy regressions prove that Bash network access, external mutation, process control, workspace escape, code execution, generic path following, and parse uncertainty cannot dispatch without current-Attempt approval, while the narrow path-free/current-directory observation set remains approval-free. File-tool regressions prove create-only and snapshot-bound replacement semantics.
- Gate regressions prove that every profile rejects empty, failed, transport-incomplete, and token-truncated candidates; a `length` Candidate is preserved and rejected without a semantic review call.
- Plan and Supervisor regressions prove acyclic criterion-aware plans, append-only revisions, source revision/hash and selector validation, non-recency evidence selection, quote count and byte limits, and exact successful Operation binding for strict `check:*` coverage.
- Accepted-uncertainty regressions prove criterion scope, actor attribution, expiry, idempotency, separation from effect approval, same-Candidate re-adjudication, retained rejection history, and a single terminal winner when acceptance races resume or cancellation.
- Context and Transcript regressions prove projected-content commitments, provider-envelope linkage, immutable Memory evidence projections, failed-operation exclusion, Unicode term search, case-sensitive literal search, write-time filters, stable exclusive pagination, and exact-sequence retrieval.
- Architecture tests prove that approval and finalization extraction retain one mutation authority in the modular monolith and add no process or network boundary.
- Release verification uses fresh `npm run lint`, `npm run check`, full Vitest, build, compaction benchmark, audit, and diff gates; the tagged workflow additionally runs the PostgreSQL 17 gate and builds/verifies all release assets.

## Consequences

Semantic completion is now fail-closed at deterministic boundaries and carries criterion-linked, Core-verifiable provenance. Operators gain an explicit way to accept irreducible criterion uncertainty without granting effect authority or rerunning an immutable Candidate. Read-only failures now leave auditable diagnostic receipts, but remain ineligible as successful completion evidence. Router, Transcript, Context, and Supervisor projections are bounded, which makes resource use predictable while requiring explicit pagination and source selection.

Effect classification can still produce false positives that add approval friction; narrowing observation execution behind argv-native capabilities or an OS sandbox remains a useful defense-in-depth improvement. Evidence selectors and plan-coverage fields expand durable and public contracts, so future changes require additive schema/version handling. Accepted uncertainty remains a sensitive operator authority and must never become implicit or model-authored. Context projection must continue avoiding redundant copies of provider payloads already owned by request envelopes. The system remains a modular monolith with one durable mutation authority; this intentionally favors transactional consistency over independently scalable semantic-control services.
