# Supervisor

## Authority

The TaskRun Supervisor governs settlement; the Agent runtime cannot declare durable success by itself. Assistant output streamed during an Attempt is provisional until the Supervisor accepts the candidate and Core persists it as the Session answer.

Candidate integrity is below every configurable Gate profile. An empty, failed, token-truncated, or transport-incomplete provider candidate cannot complete a TaskRun, including when `gateProfile=off`; Core first performs bounded provider recovery and otherwise terminalizes the Attempt with a typed integrity failure.

## Deterministic floor

Admission proposes an immutable execution policy for each new contract. Core consumes five execution modes:

- `exact_delivery` — one literal response, locally comparable;
- `semantic_delivery` — translation, rewriting, summarization, drafting, prose review, naming, or ordinary answers;
- `read_only_analysis` — repository/code/runtime investigation without mutation;
- `workspace_mutation` — durable workspace or code changes;
- `external_action` — deploy, publish, send, persistent Memory deletion, permission, or other high-impact external action.

The proposal also declares side-effect risk, evidence policy and review policy. It is not an authority grant: Core raises the policy to full review and trusted checks whenever a Workspace Goal or a current-Attempt mutation-capable operation is observed, including one that failed after its effect started. A model can never lower this floor.

Before a new TaskRun is created, the caller may choose a completion-acceptance `gateProfile`. The Web Console exposes it as a compact Review selector in the composer footer and remembers it per Workspace, so the active policy remains visible at the point of submission:

| Profile | Completion behavior | Intended use |
| --- | --- | --- |
| `off` | no deterministic or semantic completion Gate, no Gate evaluations | conversation, direct commands, or work where the operator wants the candidate immediately |
| `relaxed` | one result-oriented semantic review; no plan/check prerequisite | research, exploration, analysis, drafting, and other open outcomes |
| `strict` | deterministic prerequisites plus exact/semantic/full review as applicable | coding, releases, database work, and closed deliverables |

An omitted profile means `strict`. The selected profile is frozen in the Admission execution policy after routing, so the Router/LLM cannot change it. It affects completion acceptance only: external-action approval, Workspace Goal authorization, capability checks, and dangerous-tool policy remain active in every profile. A steer routed into an active Run does not change that Run's profile.

`external_action` has a separate effect-before-approval boundary owned by `CoreExternalActionApprovalApplication`, not by Router callbacks or Runtime providers. It persists a pending request and blocks the first Attempt before Runtime construction. Approval is bound to the next Attempt and is not a reusable Run-wide bypass. During that Attempt, Core first inspects authority without mutating it. The runtime host activates the approval atomically only after the current-Attempt, Workspace Goal, tool-attempt, and durable operation-claim guards pass, immediately before the first qualifying tool body can dispatch. The append-only activation receipt makes later qualifying calls in that same Attempt authorized without order-dependent exhaustion; read-only workspace observations do not activate it. Any later Attempt, including one created after submitted user input, requires a fresh real approval. If settlement or a transient failure would otherwise require another Attempt, Core pauses instead of launching a retry that cannot inherit authority. LLMs may classify semantic risk but cannot create, approve, activate, or substitute a user-input form for this authority.

Successful native `read` and `ls` calls produce descriptor-relative, workspace-contained read-only operation receipts that Full Supervisor review can cite. Bash has no equivalent OS sandbox: only a deliberately narrow lexical set (`echo`, `printf`, `pwd`, current-directory `rg`/`ls`, and non-dereferencing `find .` forms) remains approval-free. Generic path-reading commands, explicit symlink operands, Git commands, test runners, linters, builds, and other workspace code execution require current-Attempt effect approval even when their classified receipt is read-only. Approval-free observations do not trigger mutation governance or create an artificial Bash-check requirement; receipts without explicit workspace-effect metadata remain mutation-capable by default.

In `strict`, before semantic review Core checks authoritative prerequisites appropriate to that policy:

- read-only analysis, workspace mutation and external actions have required plan state;
- every required plan item is complete;
- a version-2 required plan covers every current objective and every Run-local `ac-*` criterion, declares dependencies, and cannot complete ahead of a missing or unfinished dependency; cumulative Roadmap Goal criteria stay in the separate `gc-*` evidence namespace;
- every required check is passed, non-stale and bound to a completed, successful `tool.bash` receipt from the current Attempt;
- the bound receipt contains the actual command, reports exit code zero, and has the same completion time recorded by the check;
- workspace mutation and external actions have at least one trusted required check;
- no durable steer/follow-up remains pending delivery.

A semantic reviewer cannot convert a failed deterministic prerequisite into success.

New Agent-authored plans use schema version 2. Core validates objective/criterion IDs against the immutable contract, records `createdAttempt` and `updatedAttempt`, validates evidence-reference syntax, and requires `replanReason` when title, scope coverage, or dependencies change. `completionEvidenceRefs` explicitly retain relevant early evidence outside the recent-operation window. Rows created before plan v2 remain readable and keep their legacy completion behavior.

When a prerequisite fails, acceptance criteria remain unevaluated rather than being mislabeled `unsupported`. The continuation receives only the actionable plan/check failures and is told to preserve completed research and deliverables. Criterion-level statuses appear only after an actual semantic review.

Agent-provided `evidence`, timestamps and success labels are untrusted input. Core derives the stored evidence from the operation result, including a bounded output projection, digest, completion time and Artifact reference when present.

## Settled review

For substantial work, the Supervisor produces a schema-validated audit of progress, evidence, contract coverage, completion, and continuation. Every acceptance criterion receives one of:

```text
covered | unsupported | contradicted | blocked
```

The review receives bounded actual operation payloads, results and effects, including Bash command, exit code, output, digest, Artifact and completion time. A `succeeded` status alone is not semantic proof: the LLM must compare the receipt content with the criterion and candidate claim. Evidence references may point only to trusted checks, supplied operations, substantive artifacts, exact Transcript entries, or selected Memory records/revisions. Sources explicitly linked by plan or prior Gate coverage remain eligible even when older than the recent-operation window. Candidate prose is not independent proof of its own claims, and invented references fail local validation.

Full-review factual coverage uses Core-verified Evidence Quotes. A quote commits to `sourceRef`, immutable revision, SHA-256 source hash, selector, and selected value. Selectors are exact text (with occurrence), 1-based inclusive line range, 0-based half-open UTF-8 byte range, or RFC 6901 JSON Pointer. Line-range quotes preserve the source's original `LF`, `CRLF`, or `CR` separators between selected lines; JSON Pointer accepts only the RFC 6901 `~0` and `~1` escapes, including the empty root pointer. Core re-resolves Artifact, successful completed Operation, exact same-Run Transcript content, or the private immutable projection of selected Memory and rejects stale hashes, invalid selectors, split UTF-8 boundaries, mismatched bytes, failed diagnostic receipts, and unavailable sources. Every selector is capped at 16 KiB of selected UTF-8 bytes, each criterion at 16 quotes, and one verdict at 128 KiB of quoted bytes. A covered `check:*` must also cite and quote its underlying `operation:*`; labels alone are not evidence. Verified quotes are embedded in the immutable Gate evaluation JSON.

Only an explicit literal response uses deterministic local completion. Core compares the complete trimmed candidate with the literal value; a mismatch starts bounded repair.

Semantic delivery uses one compact semantic-lite call containing only the contract, criteria and candidate projection. The model judges relevance, completeness, contradictions and criterion coverage; it is explicitly forbidden from demanding plans or operation receipts for text-only work. It cannot emit the final Core action.

Relaxed review uses one outcome-focused call after the candidate settles. It accepts explicit `unsupported` coverage for secondary uncertainty without automatically continuing. It still rejects a missing core deliverable, material irrelevance or incompleteness, contradiction, a genuine blocker, or actual output truncation. Plans, checks, operation receipts and Artifacts may support the result but are not ceremonial prerequisites.

Full review returns only a compact semantic verdict: delivery quality, one gating coverage receipt per TaskRun criterion, optional non-gating Workspace Goal evidence observations, and semantic failures. Core owns progress/evidence/contract/completion/continuation gate construction and the single final-action algebra. A mapped Goal criterion may accumulate evidence across Roadmap items and cannot block settlement of an item whose own outcome and verification are complete.

Full-review trajectory authority is Attempt-scoped. The bounded review payload separates current-Attempt operations from earlier operations: earlier failures remain visible as audit context, but they cannot independently create a Progress or Completion failure after a later Attempt has recovered the final state. Operation-based Progress failures must cite current-Attempt operation references, and Core drops failures grounded only in historical operations. A genuinely unresolved historical problem still blocks through current missing evidence, contradicted contract coverage, or an incomplete/contradictory final delivery. Progress snapshots are likewise consumed only when their Attempt matches the candidate being settled.

Acceptance criteria are terminal settlement conditions, not per-operation checkpoints. Open-ended research may accumulate samples, source receipts and draft artifacts across the Attempt; the Full reviewer evaluates sample thresholds, source breadth and the final set of deliverables only after the candidate settles. The review projection carries up to 24 recent artifacts with a shared 48 KB bounded head-tail content budget, byte/line counts and SHA-256 digests; CSV artifacts also expose Core-computed columns, logical data-row counts and quote balance. Multi-file research is therefore not judged from filenames or a truncated prefix alone, while large artifact sets cannot grow the semantic request without bound.

## LLM call policy

| Situation | Supervisor LLM calls |
| --- | --- |
| Gate profile `off` | 0; deliver the settled candidate directly |
| Gate profile `relaxed` | 1 result-oriented review; no deterministic plan/check preflight |
| Required plan/check prerequisite already fails | 0; start a bounded continuation for local repair |
| Exact literal delivery | 0 |
| Translation, rewriting, summarization, drafting, prose review, naming, ordinary answer | 1 compact semantic-lite call |
| Substantial settlement with valid deterministic prerequisites | 1 |
| Malformed or schema-invalid review output | no repair call; limited JSON syntax repair or fail closed locally |
| Retryable failure on the same upstream | no retry |
| Retryable failure with a separately hosted fallback | at most one fallback call |
| Known timeout, rate-limit, authentication or configuration runtime error | 0; classify locally |
| Opaque terminal runtime error | at most 1 classification call |

If the semantic review transport remains unavailable, Core blocks the TaskRun with preserved candidate/evidence state. It does not rerun completed Agent work merely to retry the reviewer.

Supervisor decisions expose `epistemicStatus=deterministic|model_assessed|degraded`. The older numeric `confidence` remains readable for compatibility but never grants authority or opens a Gate. Deterministic local decisions, model judgments, and transport/fallback recovery are therefore distinguishable without interpreting model-specific confidence scores.

Long candidates and operation receipts use bounded head/tail projections. Projection metadata is not evidence that the durable candidate was truncated; projection-only failure claims are removed locally without another LLM call.

## Actions

| Action | Meaning |
| --- | --- |
| `complete_taskrun` | persist the candidate as the final Session answer |
| `start_continuation` | start bounded repair or completion work |
| `pause_for_approval` | create/retain a durable approval request; do not auto-continue |
| `wait_for_runtime` | wait for pending durable control delivery |
| `block_taskrun` | stop on missing user/external state or non-recoverable failure |
| `steer` / `follow_up` | bounded intervention while an Attempt is active |

If a candidate is rejected, Core emits/persists rejection state, keeps the candidate in the TaskRun transcript for audit, and does not append it as the final chat answer. The next continuation must produce a complete standalone replacement. Because a continuation is a new Attempt, required checks from the rejected Attempt must be rerun and rebound after the final mutation; otherwise Core keeps the Run in bounded automatic continuation instead of terminally blocking it.

## Attempt-terminal review

Runtime failures are classified separately from settled candidate quality. Known transient provider/network failures may continue without an LLM call; approval or permission failures pause; authentication/configuration failures block. An opaque failure may use one semantic classification call. Bounded retry policy prevents an unavailable Supervisor from causing an unbounded Agent loop.

## Approval boundary

The Supervisor may request approval but cannot approve its own action. Governance owns canonical approval receipts. Early parallel related-task starts and high-impact operations remain subject to their explicit capability and approval policies.

The Web Console surfaces pending TaskRun approvals directly above the chat composer, where the operator can approve or reject them without opening the audit sidebar. A compact `Off / Relaxed / Strict` selector remains in the composer footer; Run details explains the frozen profile of the selected Run.

## Accepted uncertainty

An authenticated control-plane caller with `runs:control`, acting for an operator, may accept honest residual uncertainty for one currently `unsupported` or `blocked` TaskRun criterion. The append-only decision records the `ac-*` ID and text, immutable contract hash, actor from the HTTP principal, rationale, scope, up to 100 evidence references of at most 2,000 characters each (NUL is rejected), creation time, and optional expiry. It is not an Agent tool, cannot be model-authored, cannot cover `contradicted` evidence, and is entirely separate from effect approval.

During ordinary settlement, an active decision removes only that criterion's unsupported/blocked failure and annotates coverage with `acceptedUncertaintyId`; all other progress, evidence, contract, approval, and candidate-integrity gates still apply. When the Candidate has already been rejected and the Run blocked, accepting the last remaining uncertainty invokes a Core-only re-adjudication transaction: Core verifies the same Candidate hash and prior executed blocking decision, appends a new deterministic Gate set and Supervisor decision, changes the rejected Candidate and blocked Attempt/Run projections to accepted/completed, and publishes the preserved response without constructing a Runtime or a new Attempt. The earlier rejection event, Gate evaluations, and decision remain immutable audit history. Partial acceptance leaves the Candidate blocked, and a concurrent resume/cancellation/state transition prevents the transaction from committing stale authority.

The TaskRun remains in the ordinary `completed` terminal state while its governance view exposes both the accepted ledger and any currently unresolved uncertainty. Expiry is evaluated when settlement or re-adjudication occurs and never retroactively reopens a terminal Run. Expired decisions stay in history and appear unresolved in the current epistemic projection, so a future explicit revalidation workflow may supersede the historical conclusion without rewriting it.

## Inspection

The Web Console reads the stable TaskRun and transcript contracts, plus the Console-only context-manifest projection:

```text
GET /api/v1/task-runs/:id
GET /api/v1/task-runs/:id/transcript
GET /api/v1/console/task-runs/:id/context-manifests
```

Every client uses the same TaskRun transcript response; there is no separate Web Console transcript route. Channel integrations should use the stable TaskRun, transcript, artifact, and event-consumer routes documented in [API_V1.md](API_V1.md).
