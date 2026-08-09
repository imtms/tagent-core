# Changelog

## [0.5.1] - 2026-08-09

### Pi runtime compatibility hardening

- Restored coding-agent-compatible full-turn retry semantics on top of `pi-agent-core.AgentHarness`: retries use bounded exponential backoff, are abortable, and do not duplicate provider-library retries.
- Compacts restored context before a new turn, keeps successful turns successful when non-overflow automatic compaction fails, and retains one bounded context-overflow compaction/retry cycle.
- Makes active-turn `task_run.compact` abort the current Harness turn, compact safely, and resume unresolved work without changing the existing runtime API.
- Corrected the advertised release version and removed the last obsolete coding-agent wording from current production metadata and source comments.
- Revalidated schema validation, truncated tool-call refusal, sequential mutation batches, stable tool-result ordering, steering/follow-up, cancellation, fallback, compaction, the complete non-PostgreSQL suite, and PostgreSQL memory integration.

## [0.5.0] - 2026-08-09

### Pi runtime decoupling

- Replaced `pi-coding-agent.AgentSession` with a contained `pi-agent-core.AgentHarness` session adapter backed by `pi-ai` Models/providers, and removed `pi-coding-agent` from production code, manifests, the lockfile, tests and the installed dependency tree.
- Added Execution-owned `RuntimeTool`, result/update and model contracts. `workspace-local` no longer imports `pi-agent-core`, `core-service` no longer imports `pi-ai`, and architecture/ESLint gates restrict all production Pi imports to `runtime-pi`.
- Preserved streamed text/thinking, tool lifecycle and guards, steering/follow-up, abort queue audit, provider retry, rate-limit fallback, model/reasoning selection, historical context projection and manual compaction.
- Added restored-context and post-turn threshold compaction, non-fatal automatic-compaction failure handling, active-turn manual compaction, abortable exponential-backoff full-turn retry, and one compaction/retry recovery cycle for provider context overflow, with focused AgentHarness fault-injection coverage.
- Removed unused coding-agent TUI, built-in tool, extension, theme, template, project-resource and session-management dependency surface from the release graph.

### Runtime and control-plane reliability

- Fixed SSE replay subscription ordering so events committed at the replay/live handoff cannot be lost, and treated `ServerResponse.write(false)` as backpressure rather than a failed write while suppressing heartbeat writes until `drain`.
- Kept parallel TaskRun approvals pending when the approved inbox item cannot be claimed instead of persisting a false approval event.
- Failed and released claimed automatic continuations when runtime construction fails, keeping TaskRun, Attempt, checkpoint and continuation state consistent.

### Compatibility and upgrade

- There is no API, ABI or SQLite schema migration in this release; schema remains 40.
- Runtime deployments continue to use `TAGENT_RUNTIME=in-process`. No configuration rename is required.
- Deploy matching Core and Web Console 0.5.0 artifacts. The runtime package set is smaller because `pi-coding-agent` and its unused product dependencies are no longer shipped.

## [0.4.1] - 2026-08-09

### Runtime reliability

- Fixed overlapping Memory capture and maintenance intervals replacing the Promise that shutdown was waiting for. The worker now has an explicit stopping barrier, drains capture, maintenance, heartbeat, metric, and reindex work, and closes the PostgreSQL pool only after the worker has settled.
- Made Memory runtime and PostgreSQL pool closure idempotent, including concurrent callers, and explicitly handled asynchronous Memory heartbeat failures.
- Added bounded instance-lock heartbeat checks plus sanitized per-stage and event-loop-delay diagnostics. Synchronous heartbeat stages that cross the existing 10-second authority boundary now fail closed instead of refreshing writer readiness.
- Fenced asynchronous Session-history and Memory-recall preparation by current Run/Attempt, propagated cancellation into embeddings, and made cancellation and shutdown abort and drain preparation before persistence resources close.
- Added an idle timeout for stalled non-streaming OpenAI-compatible JSON bodies and capped Router completion tokens with the configured model limit.

### Runtime and Console efficiency

- Replaced repeated full TaskRun hydration on tool and post-tool hot paths with fenced lightweight execution-state queries while retaining full hydration for explicit TaskRun inspection.
- Changed Console Run history to a versioned lightweight summary projection and hydrates only the selected, latest, and active Runs in the Web Console.
- Added bounded incremental Transcript reads and serialized cursor-based Web merging, including tool-result reconciliation and isolation when viewing a historical Run during active execution.
- Changed new Workspace reasoning effort from `high` to `medium` and added a reproducible SQLite wall-clock benchmark for Run history, tool state, and Transcript update paths.

## [0.4.0] - 2026-08-08

### Gateway contract reliability

- Advanced SQLite through schema 40: schema 39 adds principal-scoped Session creation receipts, dedicated TaskRun command receipts, Workspace Goal operation receipts, restart `outcome_unknown` fencing and distinct settled/final event-consumer ACK watermarks; schema 40 adds durable Submission actor/provenance audit receipts.
- Added idempotent Session creation/lookup, command receipt lookup with original result/error replay, typed Approval/User Input commands and pending interactions, capability discovery, bounded Transcript pagination, batched SSE replay, slow-consumer limits, and stable Artifact 413 errors.
- Made `steer` and `follow_up` return at durable control-inbox admission instead of waiting for Runtime/provider delivery; public SSE now exposes per-type safe payloads and reduces internal events to redacted diagnostics.
- Froze the Workspace Goal Operator subset: all writes carry request IDs, definition/Roadmap edits have durable receipts, and Roadmap generation invokes the LLM at most once per request identity.
- Added channel-neutral Submission provenance, a versioned Operator endpoint allowlist, Approval-authority and receipt-recovery capability discovery, paginated Artifact metadata, complete public-event fixtures, 100-way Session concurrency coverage, and full schema-v39 drift validation.
- Updated `@tagent/core-client`, ABI fixtures, provider/consumer and migration/API contract tests, readiness receipt-age diagnostics, deployment/recovery/upgrade guidance and the release checklist for schema 40.
- Pinned the patched `nanoid` 3.3.17 transitive dependency so the full release dependency audit no longer fails on GHSA-2v37-7h3g-55p8.
- Aligned the HTTP adapter with the repository TypeBox version so clean installs compile shared ABI schemas without duplicate nominal `Static` types.

### Trusted completion evidence

- Advanced SQLite to schema 37 with operation audit payloads and check bindings to source operation ID and observation time; schema re-entry validates the trusted-evidence columns and partial index fail-closed.
- Required passed checks now accept only a completed successful Bash operation from the current Run Attempt with the actual command and zero exit code. Core derives the evidence, digest, Artifact reference and timestamp instead of trusting Agent-authored evidence text.
- Change, verification and release objectives require at least one trusted required check. The semantic Supervisor receives bounded actual operation payloads, results and effects and maps only supplied evidence references to acceptance criteria.

### Runtime and model-call efficiency

- Reduced normal substantial settlement to one Supervisor LLM call, removed the obsolete second-call schema-repair path, skipped semantic review for authoritative prerequisite failures and narrow low-risk answers, and limited transport fallback to a separately hosted upstream.
- Added local classification for common timeout, rate-limit, authentication and configuration failures, preventing avoidable Supervisor calls and repeated Agent execution when review transport is unavailable.
- Bounded online Memory recall, embedding, Session/transcript/operation queries and admission summaries; reused model runtimes; reduced full TaskRun hydration on runtime-event paths; and changed Bash output capture to linear Buffer accumulation.
- Made `task_run` batches atomic, bounded operation inspection and evidence lookup, and allowed large evidence-reference sets without exceeding SQLite host-parameter limits.

### Recovery and documentation

- Added last-resort Attempt terminalization, durable-ACK-first SSE replay, receipt-aware continuation progress signatures and check staleness that distinguishes observation from workspace mutation commands.
- Replaced the contradictory 0.2-specific upgrade guide and synchronized the maintained architecture, deployment, Gateway, persistence, runtime, Supervisor and release documentation with schema 37 and the current evidence/call policy.

## [0.3.0] - 2026-08-07

### Lightweight Workspace Goals

- Added durable Workspace Goals with immutable definition and plan revisions, canonical content hashes, human decisions, partial plan-item approval, linked TaskRuns and evidence-backed completion criteria.
- Added a lazily loaded Goals panel for creating, revising and approving Goal definitions and plans, selecting the approved plan slice, inspecting progress and linked Runs, pausing/resuming/cancelling, and explicitly closing a verified Goal.
- Kept TaskRun as the only execution runtime: Goal reads and next-action projection do not call an LLM, Goal approval does not start work, automatic successors and automatic Goal completion remain disabled, and ordinary TaskRuns do not query Goal state.
- Added scoped Console v1 Goal routes and runtime-validated ABI schemas. The Goal surface is an operator Console contract rather than a new Gateway/channel contract.

### Reliable workspace execution

- Added snapshot/content-hash-bound edits and atomic multi-file patches with preflight validation, commit-time stale checks, rollback on normal commit failure, durable operation identity and check invalidation.
- Added durable Artifact spill for large tool output with bounded head/tail previews, SHA-256 and byte metadata, explicit source-truncation reporting, and configurable storage limits.
- Added Core-owned, hash-tracked project context discovery for `AGENTS.md` and allowlisted rule files while preserving the rule that project content cannot grant capability or override approval/completion authority.

### Runtime efficiency

- Added batched TaskRun mutations, per-provider-request projection of historical tool results, compact historical TaskRun receipts, Bash timeout classification, identical failed-command fencing, composite-command guidance and evidence-aware continuation stall detection.
- Preserved existing governance and token behavior: this release does not add a cumulative Run token cap or hard model/tool-call budget.

### Persistence and upgrade

- Advanced SQLite from schema 34 to schema 35 with additive Workspace Goal tables. Existing TaskRuns are not backfilled into Goals.
- Advanced SQLite from schema 35 to schema 36 for Goal decision/evidence idempotency, dynamic evidence freshness, and mutation authorization.
- Stop Core and back up SQLite together with WAL/SHM before upgrading. A binary that only understands schema 35 must not open the migrated database.
- Deploy matching Core and Web Console 0.3.0 artifacts together. The Web Console remains independently hosted and Core remains API-only.

## [0.2.3] - 2026-08-06

### Web Console design system

- Reworked the independent Web Console around semantic color, surface, border, radius, shadow, spacing, and motion tokens shared by the conversation workbench, Audit panel, Memory Center, and Learning Center.
- Replaced the broad green-tinted surfaces with warm neutral backgrounds; green is now reserved for primary actions, selected states, and compact operational signals.
- Added persistent light and dark themes with system-preference fallback, early theme initialization, synchronized browser chrome color, and complete reduced-motion behavior.
- Refined the three-column desktop workbench, collapsible rails, message hierarchy, execution trace, Supervisor composer, empty states, dialogs, and governed Memory/Learning surfaces without changing Console ABI or runtime behavior.

### Responsive and accessible operation

- Added a two-row mobile header that keeps Workspace model and reasoning controls readable at narrow widths.
- Added a compact mobile Workspace tools menu so theme, Memory, Learning, and Learning-execution controls remain available without crowding navigation.
- Reflowed the Memory toolbar and full-screen centers for narrow devices, preserved drawer-based Workspace/Audit navigation, and verified the interface at 390-by-844 pixels.
- Added explicit accessible names for icon actions, model/reasoning controls, center refresh/close actions, and the Learning execution switch, with consistent `focus-visible`, hover, active, and disabled states.
- Added regression coverage for theme persistence, semantic tokens, responsive tools, reduced motion, and protected Console entry points.

### Compatibility

- There is no API, ABI, configuration, or database migration in 0.2.3; SQLite remains schema 34.
- Core and Web Console keep the 0.2 v1 production boundary. Deploy the matching 0.2.3 artifacts together when using the immutable release bundle.

## [0.2.2] - 2026-08-06

### Web workbench

- Changed the conversation composer so Enter always inserts a newline and submission occurs only through the Send button.
- Added single-line-to-multiline composer auto-sizing with a bounded 140-pixel height and overflow scrolling.
- Added independently collapsible desktop Workspace and Audit sidebars with browser-local preferences while preserving the existing mobile drawers.
- Replaced fixed Workspace SVG glyphs with browser-local selectable emoji at the same 26-by-26-pixel footprint.
- Fixed the local Vite reverse proxy so development requests use same-origin proxy semantics without weakening production Core CORS policy.

### Workspace execution profiles

- Added Workspace-level model and reasoning controls above the conversation. New Workspaces default to the configured primary model (`gpt-5.6-sol` by default) and `high` reasoning.
- Restricted model selection to the Core primary/fallback allowlist and reasoning to `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; non-reasoning models execute with reasoning disabled.
- Snapshot the concrete model ID and reasoning effort onto every admitted TaskRun so retries, recovery, and continuations retain their original execution profile when Workspace or Core defaults later change.
- Removed Pi's hard-coded `medium` reasoning choice and propagated the authoritative TaskRun profile through the Execution runtime port.

### Persistence and ABI

- Advanced the control-plane SQLite schema to 34 with durable `sessions` and immutable `runs` execution-profile columns. Existing TaskRuns are backfilled with the configured primary model and retain the pre-0.2.2 `medium` reasoning behavior; existing and new Workspaces default to `high`.
- Extended the Session, TaskRun, runtime-status, Console, Fastify, Core Client, readiness-probe, and documentation contracts for the new fields and configured model allowlist.
- Added migration drift checks and end-to-end regressions for model selection, TaskRun snapshotting, recovery behavior, ABI decoding, HTTP validation, and the Web controls.

### Upgrade notice

- Stop Core and back up SQLite together with WAL/SHM before upgrading. Starting 0.2.2 migrates schema 33 to 34; older binaries must not open the migrated database.
- Deploy Core before Gateway/Web, require schema 34 readiness, then deploy the matching 0.2.2 Web Console artifact.

## [0.2.1] - 2026-08-06

### Memory Console reliability

- Fixed Web Console decoding of `/api/v1/admin/memory/jobs` when capture-job provenance uses the valid `check`, `artifact`, or `operation` source types.
- Replaced the divergent Console source-reference schema with the Admin v1 ABI definition and aligned that definition with the Memory domain's `message`, `run`, `transcript`, `manual`, `check`, `artifact`, and `operation` vocabulary.
- Preserved historical provenance without deleting records, rewriting source types, or weakening strict response validation.

### ABI contract hardening

- Added domain-to-ABI, capture-job schema, Core Client decoder, and Fastify route regressions covering every Memory source type.
- Aligned `AdminConfigStatusSchema` and its success envelope with the response served by `/api/v1/admin/config/status`.

### Upgrade notice

- There is no database migration in 0.2.1; the control-plane schema remains 33.
- Redeploy the 0.2.1 Web Console to resolve the Memory Center parse failure. Upgrade Core and Web together when using the immutable release artifacts so their package manifests and ABI remain aligned.

## [0.2.0] - 2026-08-05

### Breaking changes

- Removed unversioned `/api/*` compatibility routes. Core now exposes supported HTTP contracts only under `/api/v1`.
- Removed legacy ABI namespaces, compatibility client decoders, root source facades, and legacy DTO naming from the supported surface.
- Split the Web Console from Core. Core is API-only and no longer serves Web assets or an SPA fallback.
- Changed durable submissions to use the `Idempotency-Key` header and the v1 receipt shape.
- Advanced the control-plane SQLite schema to 33. Older binaries cannot open the upgraded database.
- Standardized the release toolchain on Node.js `24.18.1` and npm `12+`.

### Architecture

- Reorganized the repository into an acyclic 13-workspace npm modular monolith with explicit ABI, client, domain, adapter, Core composition-root, and Web application boundaries.
- Restricted the Web Console to `@tagent/abi` and `@tagent/core-client`; no production workspace depends on the Web Console.
- Added workspace export and dependency-boundary checks and removed obsolete pre-refactor source, tests, design notes, and compatibility documentation.

### API and security

- Added runtime-validated public, channel, console, admin, and internal v1 schemas with standard success and error envelopes.
- Added scoped service principals and server-configured resource scopes for protected routes.
- Added exact-origin CORS validation and a production boundary for Gateway-managed OIDC-to-Core credential translation.
- Added generation-fenced event consumers with replay and explicit acknowledgements.

### Persistence and recovery

- Added schema 30 `Attempt` authority and restart classification.
- Added schema 31 canonical Governance projections and approval receipts.
- Added schema 32 capability-authorization uniqueness, indexing, and immutable identity constraints.
- Added schema 33 Learning integration events, delivery fencing, checkpoints, reconciliation, authority state, effect receipts, and migration issue ledger.
- Added an OS instance lock, single-writer lease and fence enforcement, synchronous Unit of Work, connection-level mutation guards, writer readiness, and fail-closed recovery.

### Build and deployment

- Added separate checksum-manifested Core and Web Console artifacts. The Core archive materializes internal workspaces and excludes Web assets.
- Added Core-before-Gateway deployment guidance and schema, writer, migration-issue, and consumer-watermark readiness gates.
- Removed npm-created `node_modules/.bin` links from production archives so the no-links artifact policy remains enforceable.

### Upgrade notice

- Stop every 0.1.x writer and back up SQLite together with WAL/SHM before starting 0.2.0.
- Upgrade Core first and allow forward migration to schema 33. If v33 preflight leaves open `migration_issues`, startup stops; do not bypass the ledger.
- Update Gateway and client routes to `/api/v1`, then deploy the Web Console separately with its Core origin and OIDC Gateway integration.
- Rollback to 0.1.x requires restoring the matching pre-upgrade database backup. Never run a 0.1.x binary against schema 33.
- Follow the maintained [upgrade and rollback guide](docs/UPGRADING.md) and complete the release checklist before publishing. This changelog does not assert that a particular CI or artifact run has passed.

## [0.1.13] - 2026-08-04

### Orchestration efficiency

- Added a narrow deterministic completion path for low-risk, single-answer discussion Runs, skipping the general semantic Supervisor only when there are no side effects, required checks, artifacts, truncation, or risky release/security semantics.
- Reduced automatic continuation replay to the immediately preceding attempt while retaining the durable TaskRun snapshot and falling back to the available transcript when no attempt delta exists.
- Changed Supervisor schema correction to a compact response-and-validation delta request instead of resending the full TaskRun audit payload.
- Coalesced assistant message-start and retry checkpoint writes into the existing debounced stream checkpoint while preserving immediate tool and transcript-boundary persistence.

### Quality safeguards

- Retained deterministic prerequisite gates, fresh required checks, operation receipts, full semantic review for change/release/risky or ambiguous work, and durable transcript recovery.
- Added regression coverage for lightweight completion escalation, compact Supervisor repair, continuation delta replay, and checkpoint recovery behavior.

## [0.1.12] - 2026-08-03

### Release reliability

- Preserve terminal approval receipts while allowing a new approval request for the same action in the same millisecond; pending/approved requests remain idempotently reused. This fixes the GitHub release-gate race exposed by the v0.1.11 workflow.

## [0.1.11] - 2026-08-03

### LLM-semantic Memory and Learning

- Added a shared, schema-validated LLM Semantic Judge for durable Memory capture intent and quality, natural-language corrections and communication preferences, reusable Learning sample selection, counterexample judgment, cross-language experience clustering, supported Workflow step/verification distillation, and conservative Memory feedback attribution.
- Kept deterministic safety, provenance, Required Check freshness, independent-Run support, risk/capability policy, Learning feature controls and human approval authoritative; invalid, timed-out or low-confidence semantic judgments are withheld or use the conservative deterministic fallback.
- Added a durable Schema v23 semantic-judgment cache with TTL, call-rate budget, confidence threshold, timeout, token/cost and latency metrics, plus Capture diagnostics separating extractor-zero from quality-filtered results.
- Hardened Workflow distillation so candidates require shared steps and common verification across independent successful Runs, while waiting-input/interruption outcomes without concrete failed checks are not treated as counterexamples.
- Added reproducible semantic evaluation tooling and release documentation with labeled Memory, correction and cross-language clustering results.

## [0.1.10] - 2026-08-02

### Release audit evidence

- Added a compact, line-addressable Memory/Learning implementation, documentation, test, release and 3220 restart evidence index for operator and release review.

## [0.1.9] - 2026-08-02

### Learning release boundary certification

- Added a reviewable acceptance-coverage matrix and focused tests for Memory-off API families, worker/scheduler/distiller shutdown, passive observation/distillation/evolution, active-operation denial, top-bar UI messaging and release documentation topics.
- Made the automatic-execution gate run before object lookup and governance validation for Workflow application records, Revision application and Canary promotion, giving every active operation family one consistent passive-mode denial.

## [0.1.8] - 2026-08-02

### Memory-dependent Learning release integration

- Added a persisted Schema v22 feature-control state enforcing `Memory off => Learning off => automatic execution off` across APIs, runtime Workflow recall, Learning projection and the Distillation Worker.
- Added a top-bar Learning execution switch. Off keeps passive observation, evidence capture, distillation and candidate evolution running while blocking Workflow injection and every active path; on allows execution participation but never bypasses human approval.
- Added Learning mode/status APIs, health visibility, restart persistence, automatic Worker stop/start, dependency diagnostics and detailed operations, migration and rollback documentation.
- Integrated Communication Profiles, Learning Events, corrections, conservative feedback attribution, durable Experience Distillation, governed Workflow evolution, trusted evaluation and guarded Canary support into the release build.

## [0.1.7] - 2026-08-02

### Runtime and supervision reliability

- Replaced fixed wall-clock Router, Supervisor, and Agent stream deadlines with progress-sensitive idle timeouts: active SSE output refreshes the watchdog, while genuinely stalled streams fail after the configured idle interval and remain bounded by an absolute hard timeout.
- Switched long Supervisor candidate review from a front-only 6,000-byte truncation to a bounded 8,000-byte head-tail projection that preserves the final delivery and distinguishes review projection from a real `stopReason=length` model truncation.
- Added bounded correction when a Judge mistakes an internal projection for truncated model output, preventing repeated completion-gate continuations caused by the same fixed review boundary.

### Web workbench and interaction

- Added a live, scrollable Execution trace with model output, provider reasoning when available, tool lifecycle details, durable transcript recovery, and automatic collapse after the final answer is available.
- Added durable `waiting_input` TaskRun pauses with typed in-chat forms; required user information is persisted and resumes the same TaskRun attempt chain after submission.
- Added direct in-browser preview for inline and local text/Markdown Artifacts, safe Markdown rendering, independent scrolling, source/size metadata, and retained download support.
- Added per-turn memory extraction status and persisted-memory counts while memory is enabled.

### Controlled workflow learning

- Added versioned workflow definitions, revisions, bindings, application receipts, feedback, learning policies, rollback, suspension, deletion, and explicit teaching/governance APIs.
- Active workflows can be recalled into Context Manifests with applicability, capability, confidence, and provenance controls; recalled workflows grant no additional capability or approval.
- Successful and failed task experience is projected separately, repeated evidence can distill only a candidate workflow, harmful feedback suspends active workflows, and deny-learning plus secret redaction protect sensitive tasks.

### Compatibility

- Advances the SQLite schema from version 15 to 16 for workflow-learning records. Back up the SQLite database, WAL, and SHM together before deployment; code rollback requires restoring a matching pre-upgrade database backup.

## [0.1.6] - 2026-08-02

### Performance and control-plane efficiency

- Added independent low-latency Router and Supervisor model budgets, defaulting both structured control-plane decisions to `gpt-5.6-luna` while retaining the primary Agent model for task execution and a bounded Supervisor fallback.
- Gave the LLM Session Input Router bounded recent Session, TaskRun, and active-contract context so references such as “continue with the previous plan” resolve semantically without turning background specifications into spurious objectives.
- Reduced Agent context growth by returning compact receipts for TaskRun mutations, debouncing Web SSE acknowledgements, and avoiding full-Run refreshes for ordinary tool progress events.
- Coalesced streamed `message.delta` events, rate-limited `tool.progress`, restricted checkpoint updates to recovery-relevant events, deduplicated unchanged checkpoints, cached transcript sequence cursors, and replaced full transcript parsing with count queries where only counts are needed.

### Supervisor and Gate decisions

- Replaced brittle lexical completion judgments with structured LLM Supervisor audits covering progress, evidence freshness, acceptance-criterion coverage, blockers, continuation viability, runtime failures, and final delivery quality.
- Added deterministic prerequisite fast paths: incomplete required plans and failed, missing, or stale required checks now produce auditable continuation/evidence decisions without an unnecessary LLM call; semantic delivery review still runs after local prerequisites pass.
- Bounded malformed-output correction and transport fallback behavior so Supervisor failures terminate predictably instead of repeating already-finished Agent attempts or waiting through redundant retries.
- Persisted evaluator/model identity, criterion-level evidence receipts, structured failures, rationale, confidence, and Context Manifest provenance for explainable Gate outcomes.

### Fixed

- Prevent completed TaskRuns from entering redundant continuations when criterion-level coverage already passes but a second brittle whole-contract phrase matcher rejects harmless wording differences.
- Require explicit parallel language instead of treating discourse markers such as “另外” / “another” alone as proof of independent parallel work, and classify deploy/restart/pull operations as concrete change objectives.
- Preserve earlier streamed assistant drafts when a later assistant message starts, and only clear live text after the approved response is confirmed in persisted chat history.
- Page long chat history by stable message ID, stop refetching and reparsing messages on every status poll, memoize persisted Markdown, and use lightweight plain-text rendering while streaming.

### Fixed

- Make the Contract gate the single owner of acceptance-criterion coverage receipts, eliminating duplicated Contract/Completion receipt drift from structured LLM audits. Invalid Supervisor audit output is retried internally up to three times and, if still invalid, blocks once without rerunning an already-finished Agent attempt.

### Changed

- Replaced keyword and lexical completion auditing with a structured LLM Supervisor reviewer for progress, evidence freshness, acceptance-criterion coverage, completion claims, blockers, continuation viability, runtime-failure classification, and final delivery quality. Persisted evaluations now record the evaluator, model, semantic summary, failures, and criterion evidence receipts; deterministic local logic remains only for runtime safety invariants such as repeated operations and pending control delivery.
- Reserved the main conversation for user and assistant messages by moving historical and live/recent Tool activity into the TaskRun audit workspace, collapsed by default.
- Expanded the right-side TaskRun panel into a Supervisor audit workspace with explicit progress, evidence, contract, claim, approval, and delivery standards; persisted gate failures; criterion coverage receipts; Supervisor rationale/confidence; and tool evidence drill-down.

### Fixed

- Keep the currently visible assistant response on screen until replacement content actually arrives, rather than moving it into a repeated `earlier draft retained` placeholder at every assistant message boundary.
- Reconcile missed SSE terminal events through Session polling by refreshing persisted messages, the terminal Run, and its transcript before clearing live state.
- Prefer the durable completed assistant partial when selecting the Supervisor candidate response, preventing an empty trailing assistant shell from yielding a completed TaskRun with no persisted chat answer.

### Changed

- Removed all TAgent Core token-budget control paths: no soft checkpoints, hard cumulative token ceiling, token-driven steer, token-driven continuation suppression, Memory recall token budget, or context reserve budget remains. Provider usage is observational only.
- Upgraded Session supervision to `semantic-rules-v3`, decomposing compound user input into persisted semantic objectives, timing, work kind, scope, and criterion-specific TaskRun contracts rather than carrying raw Inbox prose as the goal.
- Added criterion-by-criterion Contract Gate receipts and completion-claim validation against independent Check evidence, successful Operation receipts, or Artifacts. Agent-authored `done`/`passed` labels alone no longer establish completion.
- Context selection is governed by explicit recent-turn count and provenance, not a Core token budget; Memory recall is governed by relevance, policy, diversity, and result count.

### Fixed

- Reset provisional streaming content at every new assistant message boundary so a later steer, token-budget reminder, or continuation answer replaces the earlier draft instead of concatenating or making the visible reply appear to vanish.
- Defer the token-budget convergence steer while an assistant response is already streaming, preventing an otherwise good final answer from being replaced by a short acknowledgement of the budget warning.
- Emit an auditable `message.rejected` event when Supervisor rejects a candidate response; rejected prose remains in the Run transcript but is not persisted as the final chat answer.
- Add a contract-coverage delivery gate so short generic acknowledgements cannot complete substantial TaskRuns merely because agent-authored Plan and Check rows say `done`/`passed`.
- Strengthen continuation instructions to require a complete standalone replacement for a Supervisor-rejected candidate.

### Changed

- Context Manifests now reference stable durable Session message IDs and Run transcript sequence IDs, preserving provenance through turn compression and budget omission instead of relying on timestamp/index-derived identities.
- The Web TaskRun panel now provides Context Manifest history, selected/omitted source drill-down, and selected-source diffs between attempts.

### Added

- Immutable per-attempt Supervisor Context Manifests for Run start, resume, and continuation, including selected and omitted Session/transcript messages, TaskRun contracts, Memory inputs, selection reasons, token estimates, and stable hashes.
- Context Manifest diagnostics in the TaskRun Web panel and `GET /api/runs/:id/context-manifests`.
- An explicit capability and evidence roadmap defining when the architecture warrants promotion to `0.2.0`.

### Added

- Durable Supervisor approval requests with explicit Approve & Resume / Reject actions in the API and Web task panel.

### Changed

- Settled review now waits for durable control-message delivery instead of prematurely completing a Run.
- Progress supervision now detects repeated identical successful operations in addition to consecutive failures.

All notable changes to TAgent Core are documented here.

## [0.1.5] - 2026-08-01

### Memory operations and governance

- Added durable embedding reindex jobs with checkpoints, leases, fencing tokens, crash recovery, progress APIs, generation staging/ready/active states, and Memory Center progress controls.
- Added real embedding/extractor probes, persistent worker heartbeats, backlog age, latency/error metrics, reindex completeness, and degraded-event readiness reporting.
- Added continuous lifecycle metadata, kind-specific retention, repeated-confirmation reactivation, current-versus-history Cold consolidation, and asynchronous physical purge.
- Unified Topic and Record forgetting with tombstones, grace-period restore, delayed Cold object purge, and immutable revision preservation.
- Added recall feedback receipts that influence Ranking v2 and governance receipts for Candidate approve/reject/correct and Disputed resolution.
- Added a revisioned, human-editable Core Memory Markdown projection generated across high-value active records and deterministically injected each turn.

### Memory correctness, retrieval, and scale

- Separated raw capture source from extracted record evidence.
- Removed fixture-specific entities from production quality routing and added configurable domain ontology plus canonical SPO normalization.
- Added Ranking v2, MMR diversity, validity/current-state/trust scoring, Recall Trace v2, `memory_record_get`, provenance APIs, and deep readiness.
- Added content-hash incremental embedding indexing and then promoted reindexing to a durable, fenced job workflow.
- Expanded deterministic retrieval evaluation across identity, preference, temporal state, contradiction, organization, project decisions, residence, cross-language paraphrase, scope isolation, stale/current selection, and false positives.

### Supervisor orchestration

- Added a conservative Session Input Router that summarizes, classifies, prioritizes, and routes input as active-run steer/context, follow-up, parallel spawn proposal, discussion, clarification, defer, or independent work.
- Persisted structured TaskRun contracts, routing rationale, acceptance criteria, urgency, priority, target Run, relation, and confidence instead of copying raw Inbox text into a Run goal.
- Added semantic queue admission, manual-order override, duplicate receipts, edit reclassification, structured merge, explicit defer, and active-run context delivery.
- Added attempt-terminal failure classification, `request_evidence`, `pause_for_approval`, Agent-created Spawn Proposals, explicit proposed-to-approved-to-spawned transitions, and Web approval controls.

## [0.1.4] - 2026-08-01

> Version `0.1.4` was prepared on `main` but not tagged separately; these changes ship in the tagged `v0.1.5` release.

### Run budget elasticity

- Treat complexity-tier token allowances as soft guidance checkpoints instead of premature termination ceilings.
- Keep `TAGENT_MAX_RUN_TOKENS` as the single cumulative hard token ceiling, raise its default from 2,000,000 to 8,000,000 tokens, and steer active agents to compact and finish when crossing a soft checkpoint.

### Run admission and budget safety

- Reject opaque `release-*`, `ui-sync-*`, and `final-ui-sync-*` synchronization markers as non-actionable prompts instead of starting autonomous TaskRuns.
- Freeze dynamic Run budget classification to immutable admission data so agent-created plans/checks cannot raise their own token ceiling.
- Enforce the cumulative token ceiling during active runtime execution and abort immediately when usage crosses the limit, rather than checking only before an automatic continuation.

### Memory correctness and safety

- Reject TaskRun wrappers, verification logs, artifact publication metadata, file paths/sizes, one-off questions, and malformed Chinese-negation proposals before durable persistence or embedding.
- Stop automatic TaskRun Check/Artifact outcome capture; verified operational evidence remains in TaskRun records instead of default long-term semantic memory.
- Route direct company reporting relationships into one canonical organization Topic and apply semantic fingerprints when merging repeated facts.
- Add intent/domain routing, lexical/vector/topic relevance thresholds, empty-result recall, identity isolation, semantic deduplication, contradiction suppression, and organization-path pruning.
- Add reversible quarantine SQL with a dry-run report and audit snapshots for existing dirty records.

## [0.1.3] - 2026-08-01

### Changed

- Replace the hand-written Markdown renderer with `markdown-it` and a bounded `highlight.js` language set.
- Add tables, nested lists, fenced code highlighting, copy controls, safe external links/images, raw-HTML suppression, CJK URL handling, and responsive overflow containment.

### Fixed

- Persist accepted user turns before asynchronous memory recall and runtime setup so newly submitted messages are immediately durable and visible.
- Add optimistic chat rendering with duplicate reconciliation, failed-submit draft restoration, and submission locking.
- Continuously reconcile persisted messages while a Run is active so SSE gaps or delayed startup cannot leave the conversation stale.
- Fence Session polling and asynchronous transcript updates against workspace switches to prevent responses from an old workspace overwriting the current UI.
- Return the newest 200 persisted messages in chronological order instead of permanently hiding messages after the first 200 in long conversations.
- Refresh terminal Run state atomically and guard late event responses against cross-workspace state corruption.

## [0.1.2] - 2026-08-01

### Changed

- Stabilized the mobile viewport with dynamic viewport sizing, contained scrolling, and non-animated pinned-to-bottom updates.
- Grouped completed and live tool activity into compact, collapsed summaries so tool-heavy runs no longer dominate the conversation.
- Added clear visual cards and separators for assistant responses, with tighter responsive spacing on phones.
- Capped the composer/inbox area and improved mobile safe-area behavior to keep the chat viewport stable while typing.

## [0.1.1] - 2026-08-01

### Security and reliability

> Version `0.1.1` was an internal version increment whose changes shipped in the tagged `v0.1.2` release; no `v0.1.1` tag was published.

- Classify memory evidence as `user_explicit`, `user_context_summary`, `tool_verified_fact`, `task_outcome`, or `assistant_inference`, with trust, source-role, and verification metadata.
- Stop parsing assistant prose as durable memory; at this stage task outcomes were restricted to passed Check evidence and published Artifacts. Automatic TaskRun outcome capture is removed entirely in `0.1.4`.
- Restore context-prune deposition through a role-aware user-only durable summary path instead of capturing mixed user/assistant history.
- Enforce one hard token budget across Hot/Warm cards and complete Cold Topic pages.
- Add capture-job lease heartbeat, owner token, monotonic fencing token, and CAS complete/fail operations.
- Require PostgreSQL 17, pgvector, and pg_trgm integration tests in CI and release workflows.

## [0.1.0] - 2026-08-01

First stable source release for the documented trusted single-service deployment profile.

### Added and changed

- Add optional Hot/Warm/Cold long-term memory behind `TAGENT_MEMORY_ENABLED`, preserving the original SQLite-only behavior when disabled.
- Add PostgreSQL/pgvector/pg_trgm storage, Fact/Preference separation, bounded entity graph routing, durable capture jobs, and immutable Local Cold Markdown Topic revisions.
- Add deterministic and hybrid LLM extraction with conversation coreference, OpenAI-compatible semantic embeddings, lexical fallback, and LLM-assisted Cold consolidation.
- Add sensitive-data and stored-prompt-injection gates across capture, persistence, embedding, Cold publication, recall, and prompt injection.
- Add dynamic Agent recall, `memory_search`, `memory_topic_get`, guarded `memory_forget`, capture observability events/API, and the Web Memory Center.
- Add maintained regressions for explicit identity, positive/negative food preferences, Chinese pronoun resolution, homes, and neighbor relationships.
- Add Schema v8 Session Supervisor Inbox so all chat composer input is durably queued before TaskRun creation, with idempotent admission, atomic claim, serial dispatch, restart recovery, defer/resume, merge, and deletion of unstarted items.
- Replace direct active-run steering in the Web composer with a persistent queue panel; queued input remains outside conversation history until Supervisor selection.
- Harden TaskRun supervision against duplicate proposed steers, stale attempt progress, terminal decision crash gaps, missing continuation rows, exhausted continuation resurrection, and spawned runtime launch failures.
- Refine progress semantics so read-only tool success and assistant message completion do not erase consecutive failures; classify skipped required contract items as non-recoverable.
- Add Schema v6 durable control inbox with request idempotency, bounded admission, per-attempt fencing, serialized FIFO delivery into Pi, and restart-safe `outcome_unknown` receipts.
- Return explicit `accepted`, `full`, `closing`, and `inactive` control admission outcomes and expose Run inbox inspection.
- Align runtime queue admission with Pi 0.83 `isStreaming`/`agent_settled`, reject late steer/follow-up instead of orphaning messages, and clear/audit Pi queues during abort.
- Persist Pi summarization retry and settled lifecycle events while keeping retry and compaction execution inside Pi.
- Add Schema v5 durable event-consumer cursors with monotonic ACKs, terminal delivery evidence, and generation fencing for stale Web/SSE connections.
- Close the subscribe-after-replay race by buffering live events while the persisted event backlog is replayed.


### Changed

- Upgrade the in-process runtime from bare pi agent core to the controlled pi coding-agent `AgentSession` SDK.
- Delegate streaming steering, follow-up delivery, automatic retry, and overflow/threshold compaction to pi while preserving TAgent-owned TaskRun, transcript, policy, and operation-ledger authority.
- Use in-memory pi session/settings/model services with offline startup, disabled project resource discovery, runtime-only credentials, and TAgent custom tools only.
- Require Node.js 24.18.1 and npm 12 for the development and release baseline.

### Added

- Durable queue, retry, and compaction lifecycle events plus follow-up and manual compaction HTTP endpoints.
- Real faux-provider integration tests for controlled tools, transcript persistence, automatic retry, steering, follow-up, and terminal provider-failure audit.

## [0.1.0-alpha.1] - 2026-07-30

First public source preview of the persistent TAgent control plane.

### Added

- Durable SQLite sessions, messages, TaskRuns, plans, checks, artifacts, events, transcripts, operations, tool attempts, and continuations.
- Deterministic completion gate, atomic terminal transitions, verification staleness, and durable tool-loop guards.
- Session history and transcript context assembly with token reserves and complete-turn pruning.
- Transactional continuation claims with one-active enforcement, leases, heartbeat renewal, and owner fencing.
- Workspace-scoped `ls`, `read`, `write`, `edit`, `bash`, and `task_run` tools.
- Operation receipts for idempotent mutating tool calls and restart-safe `outcome_unknown` handling.
- Fastify HTTP/SSE API and responsive React workbench with run history, cancellation, steering, resume, Markdown rendering, and expandable tool-call diagnostics.

### Alpha limitations

- Supports one trusted process and one configured workspace. Multiple processes must not share the same database.
- Intended for localhost or trusted private-network use. The API has no authentication and must not be exposed directly to the public Internet.
- Bash restrictions are policy-based and do not provide an OS sandbox.
- Cancellation and steering do not yet provide control-plane transcript repair.
- Provider retries are not yet typed or independently audited, and context-overflow recovery is incomplete.
- Runtime checkpoints, semantic context summaries, consumer ACKs, and expiry-aware continuation takeover remain future work.

[0.1.0-alpha.1]: https://github.com/imtms/tagent-core/releases/tag/v0.1.0-alpha.1

[0.1.0]: https://github.com/imtms/tagent-core/releases/tag/v0.1.0

[0.1.2]: https://github.com/imtms/tagent-core/releases/tag/v0.1.2

[0.1.3]: https://github.com/imtms/tagent-core/releases/tag/v0.1.3


[0.1.5]: https://github.com/imtms/tagent-core/releases/tag/v0.1.5

[0.1.6]: https://github.com/imtms/tagent-core/releases/tag/v0.1.6

[0.1.7]: https://github.com/imtms/tagent-core/releases/tag/v0.1.7
