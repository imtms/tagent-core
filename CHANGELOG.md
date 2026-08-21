# Changelog

## Unreleased

## [0.8.14] - 2026-08-21

### Web Console structural refinement

- Replaced the flat Execution trace with reasoning-led stages: each reasoning pass owns its compact tool-call ledger and settled model output, so consecutive Bash/read/edit calls no longer form an undifferentiated wall.
- Consolidated Run details into one quiet section/ledger/disclosure grammar, separated Supervisor model metadata from its verdict, made token metrics wrap predictably, and removed the repeated settled Gate verdict while preserving failures and evaluation history.
- Rebuilt Goal completion criteria as a compact field group with aligned inputs, required controls, removal actions, and a responsive add action; the 390px layout now stacks the group header without truncating its explanation.
- Gave Core Memory and Memory operations the same outer gutter, section headings, count alignment, and full-width job rows; recent capture state, source identity, and job metrics now remain readable at narrow widths.
- Unified live and successful status accents on the restrained green token while retaining warning and danger only for states that need attention; no semantic color is used as a large panel or dashboard fill.

### Maintenance and verification

- Added a pure transcript-to-stage projection and regression coverage proving that reasoning, tools, and output remain in one structural group.
- Reduced obsolete and duplicate styling while extending the canonical stylesheet to 764 lines, 399 rules, 495 selectors, and 1437 declarations, within the existing hard ceilings.
- Rendered dense Tool Call, Run details, Memory jobs, and Goal criteria states in desktop and 390px layouts across both light and dark themes.

### Compatibility and deployment

- The public ABI, SQLite schema revision `2`, Memory schema, and `tagent-core/state-0.8-r2` protocol are unchanged; no data migration is required. Deploy matching `0.8.14` Core, Web Console, ABI, and Core Client artifacts.

## [0.8.13] - 2026-08-21

### Web Console hierarchy and Review visibility

- Restored the completion Review selector to the composer footer, where `Off`, `Relaxed`, and `Strict` remain visible at the point of submission and retain their per-Workspace preference.
- Removed the duplicate Review field from Workspace settings so the policy has one clear owner while Model and Reasoning remain secondary configuration.
- Increased section gutters and group spacing across empty prompts, Run details, Workspace settings, Goals, and Memory without reintroducing card walls, large color fills, feature stylesheets, or new CSS selectors.
- Preserved the quiet neutral light/dark palette, single restrained green accent, shared control grammar, and 390px responsive layout with no horizontal overflow.

### Maintenance and verification

- Added a rendered Review-control regression and documented the rule that related controls stay compact while unrelated sections receive at least one full spacing step.
- Kept the canonical stylesheet at 756 lines, 391 rules, and 494 selectors; the visual refinement adds only one declaration and remains within the existing complexity ceilings.

### Compatibility and deployment

- The public ABI, SQLite schema revision `2`, Memory schema, and `tagent-core/state-0.8-r2` protocol are unchanged; no data migration is required. Deploy matching `0.8.13` Core, Web Console, ABI, and Core Client artifacts.

## [0.8.12] - 2026-08-21

### Web Console visual system

- Replaced the four-layer Web styling cascade with one canonical `app.css`, one compact neutral light/dark token system, one restrained green accent, shared control/modal/list primitives, and a single `data-tone` mapping for operational state.
- Simplified the desktop shell to a stable Workspace sidebar, compact workspace bar, centered conversation plane, focused composer, and on-demand Run details; removed the permanent multi-column and collapsible-sidebar variants.
- Moved the per-Workspace completion Review setting out of the composer and into Workspace settings, leaving the composer responsible only for input, live state, and submission.
- Flattened Goals, Memory, Run evidence, Skills, starter prompts, and Queue actions into separator-based reading surfaces; secondary Memory governance and Queue operations now remain behind disclosures instead of competing with the primary task.
- Unified first-paint shell geometry with the mounted application and retained responsive modal drawers, focus ownership, visible keyboard focus, reduced motion, and 44px mobile touch targets.

### Maintenance and verification

- Removed the retired Gate and Memory overview components plus the former cascade, layout, design-system, and Goal stylesheets.
- Rebuilt the Web style gate around bounded source complexity, raw-color ownership, boot-shell parity, duplicate declarations, retired layouts, and bidirectional class ownership so JSX cannot introduce unstyled classes and CSS cannot retain dead class selectors.
- Documented the visual hierarchy, shared component grammar, information thresholds, responsive inspection matrix, and enforced ceilings of 800 lines, 420 rules, 500 selectors, and 1450 declarations.

### Compatibility and deployment

- The public ABI, SQLite schema revision `2`, Memory schema, and `tagent-core/state-0.8-r2` protocol are unchanged; no data migration is required. The Review selector is now under Workspace settings. Deploy matching `0.8.12` Core, Web Console, ABI, and Core Client artifacts.

## [0.8.11] - 2026-08-20

### External-action approval correctness

- Replaced per-tool exhaustion with one current-Attempt activation: approval remains valid for qualifying operations only inside its bound Attempt, while every later Attempt still requires fresh approval.
- Moved activation after Workspace Goal, tool-attempt, and durable operation-claim guards and immediately before dispatch. Pre-dispatch cancellation and guard rejection no longer consume authority, and an activation race settles the operation as `pre_effect_rejected`.
- Kept read-only workspace observations from activating approval, made submitted input in an external-action TaskRun surface a genuine next-Attempt approval instead of resuming unauthorized, and clarified the distinction between information forms and approval cards in the Console.
- Made the two split persistence boundaries retry-safe: a submitted input cannot be replayed with changed values, and an approval committed before a failed resume can retry the same bound Attempt without a second approval or duplicate approval event.
- Reused the existing append-only approval receipt store; the SQLite schema revision and public ABI remain unchanged.

### Application-surface maintenance

- Narrowed TaskRun, Skill, Context Manifest, approval, and Attempt persistence ports to methods with live application consumers, while keeping Store-only hydration and diagnostic queries internal.
- Removed unused constructor dependencies and a dead approval-domain helper, and replaced brittle source-file/count assertions with behavior and ownership invariants.
- Preserved the dormant fenced capability architecture and immutable retired-schema objects explicitly covered by compatibility tests; no public ABI, SQLite schema, Memory schema, or state protocol changed.

### Compatibility and deployment

- The public ABI, SQLite schema revision `2`, Memory schema, and `tagent-core/state-0.8-r2` protocol are unchanged; no data migration is required. Deploy matching `0.8.11` Core, Web Console, ABI, and Core Client artifacts.

## [0.8.10] - 2026-08-19

### Workspace Goal execution and recovery

- Made approved Roadmap admission one canonical, immutable binding across Inbox content, routing analysis, execution policy, Goal/revision, item, and criterion slice. Generic Inbox edit, merge, delete, defer, duplicate, and route paths can no longer rewrite Goal-owned work.
- Made Inbox claim, TaskRun creation, Goal Run attachment, and immutable Goal snapshot publication atomic. Missing or invalid Roadmap authorization now fails closed as a non-retryable failed Run instead of falling back to ordinary Workspace guidance.
- Added startup reconciliation for interrupted Inbox-to-Run attachment and idempotent Goal Run projections, while preventing queued Goal work from racing Goal revision, approval, pause, close, or cancellation.
- Prevented duplicate or delayed outcomes from older Runs from reclaiming a Roadmap item or Goal attention after a newer Run took over.

### Goal evidence and lifecycle correctness

- Bound evidence to the Run link's current Goal definition revision and current Attempt, including inline Artifact provenance and Attempt identity in evidence digests. Supervisor evidence harvesting now ignores evaluations from earlier Attempts.
- Made the newest non-stale evidence decisive per criterion, so newer valid evidence can resolve an older contradiction and newer contradictions revoke prior validity.
- Required approval and lifecycle decisions to target the currently applicable immutable revision and mapped state/idempotency conflicts consistently to HTTP 409.
- Preserved exact and semantic execution policy for ordinary Goal-guided TaskRuns unless the current Attempt observes mutation; approved Roadmap Runs retain full workspace-mutation governance.

### Console and compatibility

- Prioritized the active Goal TaskRun over Roadmap generation, exposed Roadmap `runStatus` and `retryable`, and added `nextAction.taskRunId` so a non-retryable blocked item opens its original Run. The Console offers Retry only for failed or cancelled work.
- Removed the unreachable public `skipped` Roadmap status while retaining the immutable SQLite baseline for compatible schema validation.
- The SQLite schema remains revision `2`, Memory schema and `tagent-core/state-0.8-r2` are unchanged, and no data migration is required. Deploy matching `0.8.10` Core, Web Console, ABI, and Core Client artifacts.

## [0.8.9] - 2026-08-19

### Authorization and security boundaries

- Enforced server-configured Session/Workspace resource grants on every concrete Channel, first-party Console, and Operator Read resource before reads, mutations, event-consumer changes, acknowledgements, or SSE response takeover. TaskRun routes now authorize through their owning Session, Session discovery is filtered before pagination, Session creation requires an explicit wildcard grant, and empty grants fail closed.
- Made external-action approval consumption atomic and Attempt-bound: consumed, expired, exhausted, malformed, or concurrently spent approvals are denied; finite approvals transition to `consumed` exactly at their use limit; unlimited reusable approvals remain approved.
- Required an unexpired, fenced capture-job lease for Memory renewal, completion, and failure settlement in both in-memory and PostgreSQL adapters, using the PostgreSQL database clock for persistent enforcement.
- Expanded the Bash catastrophic-command guard to recognize common equivalent `rm`, `git clean`, variable, path, and shell-stage forms while documenting it as a best-effort guardrail rather than an operating-system sandbox.

### Runtime and execution correctness

- Preserved deferred `steer` and `follow_up` delivery modes and queue order instead of converting follow-ups into steering, including the continuation boundary after an active response settles.
- Started model response-header timers only after credential resolution and distinguished credential, response-header, and SSE idle failures for Supervisor, admission, and Workspace Goal Roadmap calls.
- Bounded subprocess-tree cleanup after child exit, terminated surviving descendants, and rejected cleanup that cannot settle before its total deadline.
- Invalidated trusted checks after failed mutation-capable tool operations as well as successful mutations, and removed Bash capture files and descriptors on every Artifact-persistence or execution failure path.
- Preserved configured CORS headers when Fastify hands an event stream to the raw SSE response.

### Web Console consistency

- Added jittered exponential SSE reconnect backoff capped at 30 seconds with single-timer ownership and reset after a healthy stream.
- Cleared stale terminal streaming buffers whenever refreshed Transcript or terminal-event data contains authoritative assistant output.
- Made only the latest Artifact preview request authoritative after selection, close, or Workspace changes, and keyed requested-input forms by request identity so stale fields cannot leak into a replacement request.

### Portability and maintenance

- Replaced shell-specific build copy/reset commands with contained Node filesystem helpers and made maintained-document containment path-aware on Windows.
- Made `@tagent/workspace-local` fail early with `WORKSPACE_PLATFORM_UNSUPPORTED` on Windows because its descriptor-relative helper requires POSIX APIs, while preserving cross-platform package compilation and documentation checks.
- Treated Windows existing-directory rename errors as idempotent only after validating the already-installed content-addressed Skill bundle.

### Compatibility and upgrade

- The ABI shapes, SQLite schema revision `2`, Memory schema, and `tagent-core/state-0.8-r2` protocol are unchanged; no data migration is required.
- Credentialed deployments must configure an explicit matching Session/Workspace resource grant for concrete API resources, and a `session:*` or `workspace:*` grant for Session creation. Deploy the matching `0.8.9` Core, Web Console, ABI, and Core Client artifacts.

## [0.8.8] - 2026-08-18

### Workspace Goal continuity

- Kept a blocked or interrupted TaskRun as the Workspace Goal's active blocker only while it still owns the Goal's current-run selection. A newer guided TaskRun now takes over that selection without rewriting the earlier Run's durable status or audit history.
- Prevented delayed or duplicate outcome projection from resurrecting an older blocked TaskRun after a newer TaskRun completes, so the Goal can continue, pause, or be revised while the earlier Run remains available for explicit resume.

### Compatibility and upgrade

- No API, SQLite schema, Memory schema, or state-protocol changes are included. There are no breaking changes and no data migration is required; deploy the matching `0.8.8` Core, Web Console, ABI, and Core Client artifacts.

## [0.8.7] - 2026-08-18

### Web Console coherence

- Consolidated visible count grammar behind one formatter across Run, Memory, Goal, Skill, and message surfaces, removing mechanical `(s)` copy and incorrect singular labels.
- Simplified the empty Skills center to one upload action plus its immutable-revision guarantee, removing the duplicate no-Skills placeholder row.
- Removed the unreachable empty Audit panel and its stale `No TaskRuns` styling; the panel now exists only with real TaskRun history. Corrected the paused-input primary action to use the shared accent-contrast token and the same quiet hover/press behavior as other primary controls.
- Removed empty Workspace group headings and zero counts, repeated `No tasks` chrome for never-run Workspaces, the unusable filter and clear action for a never-created Workspace collection, empty Memory job and catalog groups, zero-only recall and job metrics, empty Memory Topic-route and Provenance sections, the static Memory enabled badge and policy explainer, the unselected Memory detail column, the empty ungenerated Core Memory editor and save action, the duplicate empty Goal navigation rail, empty Goal Roadmap, Scope, and linked-TaskRun sections, actionless completed or cancelled Goal callouts, redundant Goal header totals, and zero-only Skills totals while retaining distinct designed collection and no-match feedback where it guides a real next action. Roadmap generation and manual creation now share the immediate Next action, and switcher results plus the bottom create action stay anchored when their optional search row is absent.
- Removed zero-only Context Manifest selection summaries, Tool activity call totals, checkpoint positions, one-sided token breakdown values, empty Goal progress tracks, and empty Gate evaluation-history notices; single retained manifests no longer repeat their count, and per-Run token usage no longer carries a repeated implementation disclaimer.
- Collapsed the full Gate evaluation history behind one summarized disclosure and stopped repeating equivalent terminal phase plus default first-attempt labels across Run history, summaries, and Supervisor metadata.
- Flattened Goal evidence, Roadmap, Scope, and management surfaces into one hairline ledger while retaining the immediate Next action as the sole raised callout.
- Flattened Run contracts, checkpoints, Supervisor and Gate evidence plus Memory recall, jobs, topics, and detail metrics into continuous hairline ledgers, with a style gate preventing those dense surfaces from regressing into nested cards.
- Removed translucent overlay tokens and backdrop blur from navigation chrome, menus, dialogs, tooltips, and modal backdrops so elevation now uses opaque neutral surfaces, hairlines, and restrained shadows consistently.
- Flattened the Skills catalog, Workspace model/reasoning settings, and execution timeline into shared hairline ledgers, with automated checks preventing their rows from regaining gaps, rounded cards, or independent surfaces.
- Split operational state from the green accent across the Workspace rail and switcher, Run controls and history, Audit indicators, Memory annotations, Gate evidence, and Goal totals: running/live and active Goals now use info, completed/passed uses success, waiting/paused/blocked uses warning, failed/cancelled/interrupted uses danger, and ordinary hierarchy remains neutral. Added a style gate that rejects future semantic drift.
- Cleared mobile drawer modal state when the layout crosses to desktop so resize or rotation cannot leave the visible workspace inert, hidden from assistive technology, or blocked by an invisible backdrop.
- Moved Goal tone, approval notice, Markdown loading, and Markdown rendering utilities out of React component modules, restoring stable Fast Refresh boundaries and adding a check that prevents non-component value exports from returning to `.tsx` files.
- Preserved Workspace icon customization while rendering emoji consistently in grayscale across the rail, switcher, and picker; reused the validated string-map preference parser instead of maintaining a weaker Emoji-only storage decoder.

### Contract correctness

- Added the missing `runId` to the Console Context Manifest ABI and covered the real Fastify response through the Core Client decoder, preventing the Web contract from drifting from persisted manifests.
- Corrected Session input-routing diagnostics to use singular and plural objective grammar without changing routing behavior.

### Maintenance

- Removed the unimplemented `TAGENT_GOVERNANCE_APPROVAL_AUTHORITY` example left behind after the Governance dual-authority path was retired.
- Consolidated repeated CSS declaration lookup in the Web style gate so its visual invariants share one media-aware parser.
- Removed unused helper exports and narrowed Host/schema implementation types that are not part of supported package boundaries.
- Updated the maintained API, Gateway tuple, deployment, release, and Web design documentation for the five-profile `0.8.7` contract.

## [0.8.6] - 2026-08-17

### Retired Learning subsystem

- Preserved the complete former implementation in the `learning-archive` branch and removed its workspace, runtime composition, APIs, ABI profiles, Core Client methods, Web Console UI, configuration, workers, and active persistence repositories from `main`.
- Reduced the capability registry from eight profiles to five and kept TaskRun approvals, Workspace Goals, Memory, managed Generation activation, and recovery independent of the retired subsystem.
- Kept the former SQLite tables and indexes as inert immutable-baseline objects so existing databases retain historical rows; current runtime code no longer reads or writes them.

### Bounded hot paths

- Limited event-consumer terminal watermark detection to the newly acknowledged sequence range and replaced Transcript row counting with indexed last-sequence lookup.
- Added an Artifact-metadata-only TaskRun read view for HTTP and lightweight SSE watermark reads while retaining full Artifact content for internal governance.
- Switched Web Transcript updates to linear delta merge, coalesced streaming tokens to one state update per animation frame, and moved ABI/TypeBox validation into one cached dynamic chunk.
- Added benchmark coverage for ACK, Transcript count, and TaskRun read projections plus an enforced 400 KB / 120 KB gzip initial Web entry budget.

### Evolvable current state

- Split the deterministic SQLite schema into responsibility-focused SQL fragments and added an ordered, checksummed, append-only migration journal at public schema revision 2.
- Added transactional, restart-safe migration of exact legacy 0.8 databases with data-preservation, idempotent reopen, drift, newer-revision, immutable-journal, and failure-rollback coverage.
- Advanced the Core state protocol to `tagent-core/state-0.8-r2`, requiring one full Host restart for the first revision-2 deployment and preventing automatic rollback to an incompatible revision-1 binary.

### Runtime and delivery correctness

- Made Transcript pagination cursor-stable across concurrent appends, added bounded SSE write pumping and delivery fencing, and preserved exact event acknowledgements across reconnect and replay.
- Hardened runtime retry, cancellation, provider cooldown, and partial-response isolation so stale or failed Attempts cannot publish state after ownership changes.
- Added Generation heartbeats and candidate stabilization, kept `current` on the previous release until stabilization succeeds, and made drain and post-commit activation recovery converge without replaying privileged effects.

### Memory consistency and administration

- Fenced reindex vector writes against the current database-time lease and fencing token so reclaimed workers cannot overwrite a newer generation.
- Published capture records, topics, graph data, vectors, and job completion through one lease-validated transaction, preventing stale workers, duplicate retries, and partially visible captures.
- Switched Record and Topic administration to bounded snapshot/keyset pagination; Topic traversal now uses immutable `(created_at, topic_id)` ordering and includes an additive PostgreSQL Memory schema migration.
- Added bounded history backfill, Core Snapshot administration, recall inspection, capture/reindex job visibility, and Records/Topics browsing to the Web Console Memory surface.

### Application boundaries

- Moved Workspace Goal transition and evidence rules into Governance application services and added durable exact-replay operation receipts at the persistence boundary.
- Continued decomposing the SQLite Store into responsibility-owned repositories for Session, Message, Workspace Goal, Transcript, Skill, and operation persistence while retaining one connection and Unit of Work.
- Split Web Console workspace presentation, Inbox mutations, Run view transitions, live synchronization, and Memory presentation into focused state controllers and display components without introducing a second wire client or deployment boundary.

## [0.8.5] - 2026-08-15

### Self-managed Core generations

- Added one stable Core Host inside the existing service boundary. It supervises exactly one replaceable Generation, verifies immutable releases with the running Host's trusted verifier, persists bounded crash/activation state atomically, restarts crashes with backoff, and commits `current` only after candidate readiness.
- Added the explicitly approved `core_generation_activate` tool with receipt-before-dispatch semantics, strict versioned IPC, quiescent drain, durable Continuation handoff, candidate rollback, exact activation replay, Host crash-point reconciliation, and parent-disconnect fail-stop behavior.
- Reused `operations`, `run_events`, `run_continuations`, writer fencing, checkpoints, and existing lifecycle barriers without adding a database table or changing the `tagent-core/0.8` SQLite schema.
- Added conservative automatic crash recovery only when no operation, control/command delivery, tool attempt, input, approval, or existing Continuation is ambiguous; all `outcome_unknown` effects remain manual.
- Changed immutable deployment to stage-only after the first bootstrap. Running release activation is owned by the Host rather than the deployment script, systemd, or an additional updater process.
- Made the Host the sole system entrypoint for production, package binaries, and development. The Generation child entry is private to `@tagent/core-service` and is started only by the Host.
- Kept every Generation on the stable release-root working directory so default relative database and workspace identities survive activation and rollback.

### Unified TaskRun transcript

- Removed transcript redaction from the stable Channel projection. The single `/api/v1/task-runs/:taskRunId/transcript` response now preserves durable model reasoning, tool arguments, and complete tool results for the Web Console and every other `runs:read` client.
- Kept one transcript contract instead of adding a Web- or Console-specific endpoint, and documented `runs:read` as execution-sensitive authority.

### Compatibility and deployment

- Preserved the `tagent-core/0.8`, `tagent-memory/0.8`, and Host state protocol identities without adding persistence tables or migrations. Deploy the matching `0.8.5` Core, Web Console, ABI, and Core Client artifacts.
- Changed immutable deployment to stage releases without restarting the service; activate an already running installation through the approved Generation maintenance flow, while retaining systemd as the Host recovery boundary.

## [0.8.4] - 2026-08-15

### TaskRun and Session Inbox boundaries

- Removed the tests-only `Store.finalizeRun`, `Store.blockRun`, and `Store.completeWithGate` shortcuts. Test fixtures now exercise the same fenced TaskRun transition or Attempt cancellation authority as production.
- Removed the unmounted, unreceipted Session Inbox collection facade and narrowed application/persistence ports to the mounted `operator.session-inbox.v1` profile mutations with idempotency and collection-revision enforcement.
- Retained the negative architecture tests that prevent direct TaskRun and Inbox mutation bypasses from being reintroduced.

### Verification and compatibility

- Updated the modular-monolith, API, Gateway compatibility, deployment, release, and owning decision-record documentation for the single-authority design.
- This patch preserves the current `tagent-core/0.8` and `tagent-memory/0.8` schema identities and public feature set. Deploy the matching `0.8.4` Core, Web Console, ABI, and Core Client artifacts against fresh persistence; older release tuples remain unsupported.

## [0.8.2] - 2026-08-15

### Gateway profile correctness

- Made Session Settings, Inbox, and Skill exact replay consult durable mutation receipts before mutable model validation, live Inbox/Router work, or Skill bundle parsing and filesystem staging.
- Persisted complete immutable Inbox mutation projections and Skill resource revisions so replay returns the original item/revision/catalog body and ETag after later state changes.
- Kept the public Memory capture resource ID within its declared 256-character bound by returning the original scope ID instead of an internal composite key.

### Snapshot and large-collection pagination

- Replaced mutable Skill, Workspace Skill, and Admin Memory cursor order with immutable creation/binding keys so updating an unread member cannot move it past an existing snapshot cursor.
- Added storage-backed `limit + 1` pagination for Memory records in both in-memory and PostgreSQL adapters, removing the profile routes' silent 500-member truncation.
- Added regressions for configuration-changing restart replay, advanced-state exact replay, 256-character Memory scopes, update-between-pages traversal, and complete 501-member Memory traversal.

### Compatibility and deployment

- Updated the Gateway handoff, compatibility tuple, API guidance, release checklist evidence, README, and owning architecture decision for the corrected `0.8.2` contract.
- This patch supports only the matching `0.8.2` Core, Web Console, ABI, Core Client, and fresh `tagent-core/0.8` persistence contract. Deploy matching artifacts against empty persistence; older release tuples and stored mutation projections are unsupported.

## [0.8.1] - 2026-08-15

### Current application surface

- Removed the `AgentService` compatibility facade and its persistence-port aliases; Core composition, tests, and consumers now use `CoreApplicationCoordinator` through the single `createCoreApplication` factory.
- Removed the unused Submission `modelId` field from the Channel, application, and execution contracts. Model selection remains owned by current Session Settings.
- Deleted dead transition, workspace, metadata, and integration helpers; narrowed internal-only exports and retained only current HTTP, lifecycle, persistence, and runtime entry points.

### Fresh persistence and maintenance

- Replaced PostgreSQL Memory column-upgrade statements with direct creation and strict identity validation of the `tagent-memory/0.8` schema, serialized by a transaction advisory lock on first initialization.
- Removed obsolete compatibility, migration, dual-authority, old-route, and facade-only tests while preserving current behavior, security, recovery, architecture, release, and Gateway contract coverage.
- Updated the ABI, Gateway, Memory, operator, modular-monolith, Skills, Supervisor, finalization, release, and decision-record documentation for the single current system.

### Breaking compatibility and deployment

- This patch intentionally supports only the current `0.8.1` Core, Web Console, ABI, Core Client, and fresh SQLite/PostgreSQL persistence contracts. Older SDKs and existing unmarked or structurally different databases are unsupported.
- Deploy matching `0.8.1` artifacts against empty persistence. There is no supported in-place upgrade or rollback path, and this release does not change token budgets, pricing, cost controls, or usage accounting.

## [0.8.0] - 2026-08-15

### One current Core system

- Replaced the schema-30-through-47 migration chain with direct creation and strict structural validation of the single `tagent-core/0.8` SQLite schema, exposed to clients as persistence schema version `1`.
- Removed migration ledgers, upgrade repair paths, compatibility aliases and decoders, aggregate helpers, and the Approval and Attempt dual-authority, shadow, reconciliation, and cutover machinery.

### Gateway, operator, and maintainability

- Completed the current Gateway capability-profile, operator inbox/read, command receipt, delegated audit, pagination, conditional mutation, and readiness contracts across the ABI, Core Client, HTTP adapter, persistence, and executable probes.
- Simplified the Console HTTP surface and split the Web Console API transport, types, event stream, and administration modules without changing the current user-visible feature set.
- Removed historical migration-only tests, obsolete routes and actions, stale recovery terminology, and upgrade documentation; synchronized current persistence, Gateway, security, architecture, deployment, and release documentation.

### Breaking compatibility and deployment

- This release intentionally supports only newly created 0.8 databases and matching 0.8 ABI/Core Client consumers. Existing databases, databases without the 0.8 schema marker, structurally drifted databases, and older Gateway or SDK clients are rejected rather than upgraded.
- Deploy by creating an empty database and using the matching 0.8.0 Core, Web Console, ABI, and Core Client artifacts. There is no supported in-place database upgrade or rollback to an older binary.
- Synchronized Core, Web Console, private workspace manifests, internal dependency pins, fixtures, tests, documentation, and the lockfile at 0.8.0. This release does not change token budgets, pricing, cost controls, or usage accounting.

## [0.7.0] - 2026-08-15

### Gateway capability profiles

- Added the independent `GET /api/v1/capability-profiles` registry and detail documents without changing the closed legacy `/api/v1/capabilities` shape.
- Added ABI-owned DTOs and canonical fixtures, typed Core Client methods, bounded opaque-cursor reads, resource-scoped authorization, conditional exact-replay mutations, durable operation receipt lookup, redacted public projections, and separated Core/delegated audit identity for the profile registry.
- Added SQLite schema 47 with durable profile revisions, mutation and operation receipts, audit events, Inbox/catalog collection revisions, and idempotent fail-closed migration validation.
- Added a real Core provider contract harness and independent `@tagent/abi` and `@tagent/core-client` release tarballs containing JavaScript, declarations, JS/declaration source maps, portable SHA-256 files, and isolated install smoke tests.

### Release and maintenance

- Removed stale current-release, schema, test-fixture, and two-artifact documentation left from the 0.6 line while retaining the legacy v1 capabilities shape, first-party Console routes, and historical migration tests required for compatibility and upgrade coverage.
- Extended the production readiness probe, CORS contract, compatibility matrix, deployment/upgrade runbooks, and release checklist for profile negotiation, delegated audit headers, revision ETags, durable profile receipts, and all four release artifacts.
- Synchronized Core, Web Console, private workspace manifests, internal dependency pins, capability metadata, fixtures, tests, documentation, and the lockfile at 0.7.0.

### Compatibility and upgrade

- The new Gateway profiles add HTTP routes and fine-grained service scopes. Strict consumers must deploy the matching 0.7.0 ABI/Core Client SDK and explicitly configure only the profiles they use; Gateway-owned OIDC, ACL, routing, outbox, external delivery, Fake Core, network-fault, and client-matrix behavior remains outside Core.
- Back up SQLite together with WAL/SHM before upgrade. Schema advances from 46 to 47; a schema-46-only binary must not open schema 47, and rollback requires the matching pre-upgrade database backup.
- This release does not change token budgets, pricing, cost controls, or usage accounting.

## [0.6.7] - 2026-08-14

### TaskRun recovery

- Fixed the Web Console Resume action for a resumable blocked TaskRun when that same Run is the Workspace's active selection; another active Run and pending approval still fail closed.
- Added first-class `model_cooldown` classification, provider reset-window parsing, existing same-Attempt retry/fallback, and a durable delayed continuation after those bounded options are exhausted.
- Added SQLite schema 46 with `run_continuations.not_before` and a due-time claim index. Cooldown recovery cannot be claimed early, survives restart, is cancelled by manual Resume, and does not create a false repeated-gate-state stall.

### Stable runtime context

- Removed mutable TaskRun, execution-policy, Workspace Goal, and recalled-Memory content from the fixed system prompt, along with duplicate durable-snapshot text in Resume prompts.
- Core now refreshes that state before every provider request and appends it as one ephemeral final user message. The dynamic tail is included in context budgeting and the exact durable request envelope but is not written to Session or TaskRun transcript history.
- Removed the obsolete TaskRun/Memory parameters from the fixed system-prompt builder so future callers cannot accidentally destabilize the prefix.

### Compatibility and upgrade

- The Channel continuation shape now includes `notBefore`; strict consumers must deploy the matching 0.6.7 ABI/client. There is no HTTP route or configuration change.
- Back up SQLite together with WAL/SHM before upgrade. A schema-45-only binary must not open schema 46; rollback requires the matching pre-upgrade database backup.
- Synchronized Core, Web Console, all 13 private workspace manifests, internal dependency pins, capability metadata, fixtures, tests, documentation, and the lockfile at 0.6.7. This release does not change token budgets, pricing, cost controls, or usage accounting.

## [0.6.6] - 2026-08-14

### Portable release verification

- Fixed Core and Web `.sha256` assets to record only the archive basename, so `sha256sum -c` works after both files are downloaded into any directory, including paths containing spaces.
- Added an executable regression test and release checklist gate for downloaded checksum portability. The 0.6.5 tarball digests were correct, but its checksum files contained the ephemeral GitHub runner path; use 0.6.6 assets for direct verification.

### Compatibility and upgrade

- There is no runtime code, HTTP API, ABI, configuration, or SQLite schema migration in this release; schema remains 45.
- Synchronized Core, Web Console, all 13 private workspace manifests, internal dependency pins, capability metadata, fixtures, tests, and the lockfile at 0.6.6. Deploy matching Core and Web Console 0.6.6 artifacts.

## [0.6.5] - 2026-08-14

### Runtime ownership and provider recovery

- Replaced timer-bounded runtime disposal with an asynchronous quiescence barrier that cancels and joins owned runtime, preparation, control-delivery, and execution work before releasing persistence or writer authority.
- Made cancellation ownership explicit across tools, subprocesses, workspace edits, Artifacts, Memory recall, context enrichment, and Session history; started same-process work is joined after cancellation, and HTTP operations derive request-lifetime signals.
- Added a deterministic provider wire-fault fixture and stricter OpenAI-compatible stream completion, covering resets, incomplete/malformed SSE, empty responses, byte-identical retries, and failed-partial isolation.

### Durable recall, errors, and verification

- Added bounded, case-sensitive `history_search` over the current TaskRun's durable transcript so exact facts omitted by compaction summaries remain recoverable without cross-Run authority or unbounded reads.
- Added stable structured tool error metadata across execution receipts, Pi tool results, public transcript items, and lifecycle events, distinguishing pre-dispatch cancellation from failures after invocation.
- Replaced timing-based critical runtime synchronization with event-driven probes, added reproducible fixed-seed state-machine properties, and introduced an executable compaction summary-loss benchmark.
- Added lightweight `.agents` decision records with an executable consistency gate, and removed obsolete teardown test patterns and duplicated tool-error code catalogs.

### Compatibility and upgrade

- The Channel and Console ABI changes are additive optional tool-error fields; there is no configuration or SQLite schema migration, and schema remains 45.
- Synchronized Core, Web Console, all 13 private workspace manifests, internal dependency pins, capability metadata, fixtures, tests, and the lockfile at 0.6.5. Deploy matching Core and Web Console 0.6.5 artifacts.

## [0.6.4] - 2026-08-14

### Web Console workspace experience

- Stabilized the Workspace rail under large lists by keeping the New workspace action and search field at fixed, consistent sizes while scrolling only the Workspace list.
- Added a theme-aware startup skeleton and synchronized browser theme color so the first paint matches the loaded Console instead of flashing a blank or mismatched surface.
- Refined the empty Workspace experience with TAgent branding, clearer starter cards, and more specific descriptions that make first actions easier to scan.
- Improved medium-width behavior by progressively collapsing Skills and Workspace controls to titled icons while retaining the existing touch-oriented mobile layout.

### Compatibility and upgrade

- Repacked the desktop Gate selector into a denser two-column layout without changing Gate profiles, persistence, or execution semantics.
- There is no HTTP API, ABI, configuration, or SQLite schema migration in this release; schema remains 45.
- Synchronized Core, Web Console, all 13 private workspace manifests, internal dependency pins, capability metadata, fixtures, tests, and the lockfile at 0.6.4. Deploy matching Core and Web Console 0.6.4 artifacts.

## [0.6.3] - 2026-08-14

### Durable provider dispatch and credential boundaries

- Added schema 45 Attempt request envelopes, persisting and reading back the exact provider-dialect request body with canonical payload/envelope hashes before network dispatch; malformed, mismatched, or relationally inconsistent rows fail closed.
- Replaced plaintext runtime credential options with opaque `CredentialReference` plus per-request resolution across Pi, Router, Supervisor, Roadmap, Semantic Judge, embeddings, extraction, and consolidation so rotation is visible without storing secrets in durable configuration.
- Added a runtime-neutral `SubprocessPort`; every Workspace child process now receives a credential-scrubbed environment, bounded stdin, process-group TERM-to-KILL cancellation, and disposal-aware lifecycle handling.

### Tool composition and execution authority

- Split the former monolithic Workspace tool implementation into Bash, filesystem, Memory, and TaskRun providers registered through an immutable `ToolRegistry`.
- Added an Execution-owned `ToolExecutionPipeline` that binds one catalog, enforces Core authorization, binds call identity to tool name and arguments, and safely replays durable mutation receipts without repeating provider effects or settlement.
- Removed the legacy `createTools` and static API-key compatibility paths; composition now supplies an explicit subprocess port and retains the registry/pipeline lifecycle.

### Compatibility and upgrade

- Updated security, runtime, persistence, Gateway readiness, upgrade, and release documentation for the schema-45 and exact-dispatch boundaries.
- Synchronized Core, Web Console, all 13 private workspace manifests, internal dependency pins, capability metadata, fixtures, tests, and the lockfile at 0.6.3. Deploy matching Core and Web Console 0.6.3 artifacts.

## [0.6.2] - 2026-08-13

### Configurable completion Gate

- Added user-selectable `Off`, `Relaxed`, and `Strict` completion Gate profiles before TaskRun creation, with a prominent responsive selector above the Web composer and per-Workspace persistence.
- `Off` delivers the runtime result without completion review; `Relaxed` performs one outcome-focused semantic review without deterministic plan/check ceremony; `Strict` preserves full plan, trusted-check, and criterion-level enforcement.
- Froze the selected profile at Admission, carried it through Channel and Console contracts, and included it in Submission idempotency identity while retaining `Strict` as the compatibility default for older clients and persisted TaskRuns.
- Preserved explicit external-action approval, Workspace Goal authority, and mutation-capable tool safety across every Gate profile.

### Supervisor accuracy and execution reliability

- Fixed deterministic Router fallback normalization so compatible fallback classifications no longer surface as an inconsistent execution policy profile.
- Stopped deferred semantic-contract prerequisites from being rendered as repeated `unsupported` failures, and bounded multi-artifact and CSV evidence supplied to semantic review.
- Improved read-only Bash classification, open-task artifact assessment, continuation scheduling, and relaxed review handling of explicit uncertainty so exploratory research does not loop on strict closed-task criteria.
- Updated the Channel/Console ABI, Web Console, Supervisor/finalization documentation, release guidance, and regression coverage for the new behavior.

## [0.6.1] - 2026-08-13

### Cross-Workspace Skills center

- Replaced the conversation-owned single-Skill flow with one shared Skills center supporting independent upload, immutable in-browser edits, catalog deletion, revision history, usage counts, and up to 32 references per Workspace.
- Workspace references now target Skill identities and resolve their latest revisions when a TaskRun is admitted. Every referenced revision is frozen in `contract.skills`, projected to Pi resources, and recorded separately in the Context Manifest.
- Added SQLite schema 44 with `workspace_skill_bindings`, migrating every schema-43 single revision binding without changing the referenced Skill identity. Deleting a catalog entry removes its references but preserves content-addressed files and self-contained historical TaskRun snapshots.
- Added typed Console routes and client decoders for catalog details, revisions, upload/edit/delete, and atomic Workspace reference replacement; redesigned the conversation-header control as a responsive shared-library picker and editor.
- Synchronized Core, Web Console, all 13 private workspace manifests, internal dependency pins, capability metadata, release fixtures, documentation, tests, and the lockfile at 0.6.1. Deploy matching Core and Web Console 0.6.1 artifacts.

## [0.6.0] - 2026-08-13

### Core-managed Workspace Skills

- Added validated `SKILL.md` and ZIP ingestion, immutable content-addressed revisions, a saved Skill catalog, and one active revision binding per Workspace Session.
- Frozen the selected revision into each newly admitted `TaskRun`, Context Manifest, and continuation contract so later uploads, switches, or disable actions never alter running work.
- Added first-party Console ABI, typed client decoding, authenticated list/read/upload/select/disable routes, SQLite schema 43 persistence, and `skill.invoked` audit evidence.

### Native Pi execution and Web Console

- Registered frozen Skill projections through `AgentHarness.resources.skills` and invoked them through `AgentHarness.skill(name, prompt)`; Core does not flatten Skill instructions into an ordinary user prompt and does not modify `pi-agent-core`.
- Added a conversation-header Skill control with file selection, drag and drop, active revision state, saved Skill selection, disable action, validation feedback, keyboard focus containment, responsive layout, and light/dark presentation.
- Documented the Skill format, lifecycle, snapshot semantics, Console API, upload bounds, and runtime/security boundary.

### Security, compatibility, and upgrade

- Rejects invalid UTF-8/frontmatter, traversal and absolute paths, duplicate ZIP paths, symlinks, ZIP64/multi-disk/inconsistent archives, oversize content, out-of-root files, and tampered content-addressed revisions.
- SQLite advances from schema 42 to 43 with `skills`, immutable `skill_revisions`, and `session_skill_bindings`. Back up SQLite/WAL/SHM before upgrade; schema-42-only binaries must not open the migrated database.
- Synchronized Core, Web Console, all 13 private workspace manifests, internal dependency pins, capability metadata, release fixtures, documentation, tests, and the lockfile at 0.6.0. Deploy matching Core and Web Console 0.6.0 artifacts.

## [0.5.6] - 2026-08-13

### Workspace navigation and interaction

- Consolidated Workspace navigation into a searchable switcher with pinned and recent grouping, contextual actions, keyboard shortcuts, intent-based prefetching, loading feedback, and focused empty states.
- Hardened keyboard and screen-reader operation across dialogs, popovers, drawers, and icon actions, and added deliberate swipe gestures for mobile drawers without changing desktop behavior.
- Refined the responsive workbench, compact mobile controls, dark theme, safe-area handling, and interaction feedback while preserving TAgent's warm neutral visual language and green semantic accents.

### Conversation reading experience

- Deferred rich Markdown rendering and retained lightweight live text during active output, reducing work on long conversations without changing persisted content or rendering safety.
- Clarified the reading hierarchy between user messages, assistant responses, execution detail, and governance surfaces; added quiet date and relative-time orientation for long histories.
- Preserved the operator's reading position during live updates, exposed a return-to-latest affordance only when useful, and kept new-message behavior stable across history loading and active streaming.
- Moved repeated role labels, timestamps, copy actions, and per-turn Memory extraction status into a quieter metadata layer while retaining accessible sender names and touch-discoverable controls.

### Maintenance, compatibility, and upgrade

- Synchronized Core, Web Console, all 13 private workspace manifests, internal dependency pins, capability metadata, release fixtures, and the lockfile at 0.5.6.
- There is no HTTP API, ABI, configuration, or SQLite schema migration in this release; schema remains 42.
- Deploy matching Core and Web Console 0.5.6 artifacts. Existing 0.5.5 schema-42 backups and rollback requirements are unchanged.

## [0.5.5] - 2026-08-12

### Chat-first Web Console

- Rebalanced the workbench around conversation: Supervisor audit detail now starts collapsed, while pending approvals, requested input, failures, and blocked work remain visible at the point of action.
- Added searchable and pinnable Workspace navigation with Pinned/Recent grouping, unread activity indicators, loading skeletons, and a compact mobile header with progressively disclosed workspace actions.
- Added per-Workspace draft persistence, IME-safe keyboard submission, input history, composer focus shortcuts, failed-send recovery, starter prompts, long-history context, and a floating return-to-latest control.
- Refined responsive, dark-theme, safe-area, and hidden-drawer behavior and introduced a small TAgent connection mark without changing the existing warm neutral visual language.

### Compatibility and upgrade

- Pending approvals are surfaced directly above the composer; governance state and audit detail remain available in the contextual Run panel.
- There is no HTTP API, ABI, configuration, or SQLite schema migration in this release; schema remains 42. Deploy matching Core and Web Console 0.5.5 artifacts.

## [0.5.4] - 2026-08-12

### Execution safety and proportional governance

- Added a pre-effect approval boundary for routed `external_action` TaskRuns. Admission pauses before Runtime launch, approval is bound to the next Attempt, and the runtime host atomically consumes that authorization before the first mutation-capable tool call.
- Persisted Admission execution policy in Session Inbox records through SQLite schema 42, closing the gap where an in-memory Router classification could be lost before TaskRun creation.
- Raised governance after failed mutation-capable operations whose effect already started, while retaining an explicit `pre_effect_rejected` escape hatch for guards that prove no effect began.

### Reliability and latency

- Renewed continuation leases during context preparation, scheduled recovery for every claim, and safely requeued pre-launch failures instead of leaving Runs permanently running.
- Replaced the legacy direct-start path with standard Inbox Admission, requeued only the affected continuation lease after preparation failure, and now requires a fresh Attempt-bound approval before external-action continuation instead of starting a guaranteed unauthorized retry.
- Made continuation instructions policy-specific, so semantic and exact deliveries no longer receive artificial Bash/check requirements.
- Expanded ambiguous external-action routing, sends open-ended imperatives to the semantic Router, and fails conservatively when semantic classification is unavailable. Explicit long-term Memory deletion now enters the same pre-launch approval path while explanatory requests remain semantically distinguishable.
- Bounded PostgreSQL Memory connection/query/statement timeouts and shutdown joins, kept cooperative cancellation cleanup, refreshed Run liveness during bounded silent tools, capped Submission/control content at 200,000 characters, and enforced a hard projected context budget for oversized latest turns.

### Compatibility and upgrade

- SQLite advances from schema 41 to 42 by additively storing `session_supervisor_inbox.execution_policy_json`. Back up SQLite/WAL/SHM before upgrade; schema-41-only binaries must not open the migrated database.
- Approval ABI adds `execute_external_action` and terminal `consumed` state. Deploy matching Core and Web Console 0.5.4 artifacts.

## [0.5.3] - 2026-08-12

### Operator Read API

- Added the independently discoverable `operator.read.v1` profile with bounded Session inventory, complete per-Session TaskRun history and unambiguous latest-TaskRun reads, without changing the closed legacy Operator 1.0 allowlist.
- Added runtime-validated ABI schemas and fixtures, typed Core Client methods, scoped Fastify routes, stable snapshot-membership keyset cursors, deterministic public summaries and schema-41 ordered indexes.
- Covered tied timestamps, concurrent inserts, cursor retry/mismatch/restart, empty versus missing Sessions, scope enforcement, large histories, migration re-entry/drift and public DTO redaction.
- Kept Gateway OIDC, resource ACLs, WebSocket/northbound projection, fake Core and Gateway compatibility jobs outside Core; deferred filters, tombstones, bootstrap, batch reads and change feeds until an evidenced need.

### Proportional TaskRun governance

- Added an Admission-owned execution policy with exact delivery, semantic delivery, read-only analysis, workspace mutation and external-action modes; Core normalizes inconsistent or legacy contracts without allowing a model proposal to lower the required safety level.
- Exact literal responses now complete through local comparison, ordinary text work uses one compact semantic judge, and read-only `read`/`ls` operations create citable observation receipts without being treated as workspace mutation.
- Workspace changes, Bash execution, Workspace Goal work and external actions retain required plans, full semantic review and trusted current-Attempt checks.

### Supervisor efficiency and correctness

- Reduced the LLM role to semantic delivery quality, per-criterion coverage and semantic failures. Core alone derives progress, evidence, contract, completion and continuation gates plus the final action.
- Removed the obsolete model-authored five-gate/action response parser and its compatibility fixtures, eliminating a second policy path that was neither persisted ABI nor requested by current prompts.
- Rejects invalid Supervisor schemas locally without a repair-model call, removes length-based criterion inference, and clears consecutive operation failures after a successful tool call.

### Contracts, documentation and release

- Persisted and exposed the normalized execution policy through TaskRun domain, ABI and HTTP projections, with conservative fallback for existing contracts that predate the field.
- Updated the Supervisor, execution-efficiency, Gateway handoff and release documentation for the proportional policy and current call counts.
- Synchronized Core, Web Console and all private workspace manifests, internal dependency pins, capabilities and release fixtures at 0.5.3.

### Compatibility and upgrade

- `GET /api/v1/capabilities` now advertises `operator.read.v1` only through the string-valued `apiVersions` list; consumers negotiate the separate `/api/v1/operator/capabilities` profile, so the closed Operator 1.0 object remains decoder-compatible. Deployments must still accept the new schema-41 marker.
- The TaskRun execution-policy fields are additive; existing stored contracts remain readable and are normalized conservatively.
- SQLite advances from schema 40 to 41. Back up SQLite/WAL/SHM before upgrade; schema-40-only binaries must not open the migrated database. Deploy matching Core and Web Console 0.5.3 artifacts.

## [0.5.2] - 2026-08-10

### Pi runtime replacement correctness

- Kept current-turn thinking blocks and full tool results intact until the turn completes; historical projection now starts strictly before the latest real user message.
- Replaced retry, fallback, overflow and manual-compaction recovery prompts with transcript-invisible continuations, while retaining failed provider messages only in the durable audit transcript and removing them from active model context.
- Made controls accepted during retry backoff, compaction and terminal provider failure deterministic: they are delivered by a continuation or explicitly cleared on abort, and `runtime.settled` is emitted only once for the complete Attempt runtime cycle.
- Restored bounded provider header/body idle timeouts (including the documented zero-means-disabled setting), abort propagation into compaction requests, conservative generic OpenAI-compatible `store` omission without overriding provider dialect detection, primary-model retry before fallback, and successful-overflow answer retention.

### Maintenance and release

- Removed predecessor- and SDK-version-bound wording from current runtime code and tests, consolidated the duplicate Pi replacement design note into the maintained runtime contract, and corrected stale project/security release-line descriptions.
- Synchronized Core, Web Console and all private workspace manifests, internal dependency pins, capabilities and release fixtures at 0.5.2.

### Compatibility and upgrade

- There is no HTTP API, ABI, configuration or SQLite schema migration in this release; schema remains 40.
- Deploy matching Core and Web Console 0.5.2 artifacts. Existing 0.5.x schema-40 backups and rollback requirements are unchanged.

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

- Reworked the independent Web Console around semantic color, surface, border, radius, shadow, spacing, and motion tokens shared by the conversation workbench, Audit panel, and Memory Center.
- Replaced the broad green-tinted surfaces with warm neutral backgrounds; green is now reserved for primary actions, selected states, and compact operational signals.
- Added persistent light and dark themes with system-preference fallback, early theme initialization, synchronized browser chrome color, and complete reduced-motion behavior.
- Refined the three-column desktop workbench, collapsible rails, message hierarchy, execution trace, Supervisor composer, empty states, dialogs, and governed Memory surfaces without changing Console ABI or runtime behavior.

### Responsive and accessible operation

- Added a two-row mobile header that keeps Workspace model and reasoning controls readable at narrow widths.
- Added a compact mobile Workspace tools menu so theme and Memory controls remain available without crowding navigation.
- Reflowed the Memory toolbar and full-screen centers for narrow devices, preserved drawer-based Workspace/Audit navigation, and verified the interface at 390-by-844 pixels.
- Added explicit accessible names for icon actions, model/reasoning controls, and center refresh/close actions, with consistent `focus-visible`, hover, active, and disabled states.
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
- Follow the current [deployment and rollback contract](docs/DEPLOYMENT_AND_GATEWAY.md) and complete the release checklist before publishing. This changelog does not assert that a particular CI or artifact run has passed.

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

### LLM-semantic Memory

- Added a shared, schema-validated LLM Semantic Judge for durable Memory capture intent and quality, natural-language corrections and communication preferences, and conservative Memory feedback attribution.
- Kept deterministic safety, provenance, Required Check freshness, independent-Run support, risk/capability policy, and human approval authoritative; invalid, timed-out or low-confidence semantic judgments are withheld or use the conservative deterministic fallback.
- Added a durable Schema v23 semantic-judgment cache with TTL, call-rate budget, confidence threshold, timeout, token/cost and latency metrics, plus Capture diagnostics separating extractor-zero from quality-filtered results.
- Added reproducible semantic evaluation tooling and release documentation with labeled Memory and correction results.

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
