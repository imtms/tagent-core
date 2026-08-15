# Supervisor

## Authority

The TaskRun Supervisor governs settlement; the Agent runtime cannot declare durable success by itself. Assistant output streamed during an Attempt is provisional until the Supervisor accepts the candidate and Core persists it as the Session answer.

## Deterministic floor

Admission proposes an immutable execution policy for each new contract. Core consumes five execution modes:

- `exact_delivery` — one literal response, locally comparable;
- `semantic_delivery` — translation, rewriting, summarization, drafting, prose review, naming, or ordinary answers;
- `read_only_analysis` — repository/code/runtime investigation without mutation;
- `workspace_mutation` — durable workspace or code changes;
- `external_action` — deploy, publish, send, persistent Memory deletion, permission, or other high-impact external action.

The proposal also declares side-effect risk, evidence policy and review policy. It is not an authority grant: Core raises the policy to full review and trusted checks whenever a Workspace Goal or a current-Attempt mutation-capable operation is observed, including one that failed after its effect started. A model can never lower this floor.

Before a new TaskRun is created, the caller may choose a completion-acceptance `gateProfile`. The Web Console exposes the choice above the composer and remembers it per Workspace:

| Profile | Completion behavior | Intended use |
| --- | --- | --- |
| `off` | no deterministic or semantic completion Gate, no Gate evaluations | conversation, direct commands, or work where the operator wants the candidate immediately |
| `relaxed` | one result-oriented semantic review; no plan/check prerequisite | research, exploration, analysis, drafting, and other open outcomes |
| `strict` | deterministic prerequisites plus exact/semantic/full review as applicable | coding, releases, migrations, and closed deliverables |

An omitted profile means `strict`, preserving historical Runs and API clients. The selected profile is frozen in the Admission execution policy after routing, so the Router/LLM cannot change it. It affects completion acceptance only: external-action approval, Workspace Goal authorization, capability checks, and dangerous-tool policy remain active in every profile. A steer routed into an active Run does not change that Run's profile.

`external_action` has a separate effect-before-approval boundary. Admission persists a pending request and blocks the first Attempt before Runtime construction. Approval is bound to the next Attempt and atomically consumed by the runtime host before its first mutation-capable tool call; it is not a reusable Run-wide bypass. If settlement or a transient failure would otherwise require another Attempt, Core pauses for a fresh next-Attempt approval instead of automatically launching a retry that cannot inherit authority. LLMs may classify semantic risk but cannot create, approve, or consume this authority.

Successful `read` and `ls` calls produce read-only operation receipts that Full Supervisor review can cite. Bash commands in the bounded read-only allowlist (for example `rg`, `git diff`, and test/check commands) also carry an explicit read-only workspace effect. These observations do not trigger mutation governance or create an artificial Bash-check requirement; receipts without explicit workspace-effect metadata remain mutation-capable by default.

In `strict`, before semantic review Core checks authoritative prerequisites appropriate to that policy:

- read-only analysis, workspace mutation and external actions have required plan state;
- every required plan item is complete;
- every required check is passed, non-stale and bound to a completed, successful `tool.bash` receipt from the current Attempt;
- the bound receipt contains the actual command, reports exit code zero, and has the same completion time recorded by the check;
- workspace mutation and external actions have at least one trusted required check;
- no durable steer/follow-up remains pending delivery.

A semantic reviewer cannot convert a failed deterministic prerequisite into success.

When a prerequisite fails, acceptance criteria remain unevaluated rather than being mislabeled `unsupported`. The continuation receives only the actionable plan/check failures and is told to preserve completed research and deliverables. Criterion-level statuses appear only after an actual semantic review.

Agent-provided `evidence`, timestamps and success labels are untrusted input. Core derives the stored evidence from the operation result, including a bounded output projection, digest, completion time and Artifact reference when present.

## Settled review

For substantial work, the Supervisor produces a schema-validated audit of progress, evidence, contract coverage, completion, and continuation. Every acceptance criterion receives one of:

```text
covered | unsupported | contradicted | blocked
```

The review receives bounded actual operation payloads, results and effects, including Bash command, exit code, output, digest, Artifact and completion time. A `succeeded` status alone is not semantic proof: the LLM must compare the receipt content with the criterion and candidate claim. Evidence references may point only to trusted checks, supplied operations, substantive artifacts, or selected Memory records/revisions. Candidate prose is not independent proof of its own claims, and invented references fail local validation.

Only an explicit literal response uses deterministic local completion. Core compares the complete trimmed candidate with the literal value; a mismatch starts bounded repair.

Semantic delivery uses one compact semantic-lite call containing only the contract, criteria and candidate projection. The model judges relevance, completeness, contradictions and criterion coverage; it is explicitly forbidden from demanding plans or operation receipts for text-only work. It cannot emit the final Core action.

Relaxed review uses one outcome-focused call after the candidate settles. It accepts explicit `unsupported` coverage for secondary uncertainty without automatically continuing. It still rejects a missing core deliverable, material irrelevance or incompleteness, contradiction, a genuine blocker, or actual output truncation. Plans, checks, operation receipts and Artifacts may support the result but are not ceremonial prerequisites.

Full review returns only a compact semantic verdict: delivery quality, one coverage receipt per criterion, and semantic failures. Core owns progress/evidence/contract/completion/continuation gate construction and the single final-action algebra. The obsolete model-authored five-gate/action response is rejected instead of maintaining a second policy path.

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

The Supervisor may request approval but cannot approve its own action. Governance owns canonical approval receipts. Early parallel related-task starts, high-impact operations, and active Learning actions remain subject to their explicit capability and approval policies.

The Web Console surfaces pending TaskRun approvals directly above the chat composer, where the operator can approve or reject them without opening the audit sidebar. A compact `Off / Relaxed / Strict` selector appears before the input itself; the sidebar remains inspection-only and explains the frozen profile of the selected Run.

## Inspection

The Web Console reads versioned console projections:

```text
GET /api/v1/console/task-runs/:id
GET /api/v1/console/task-runs/:id/context-manifests
GET /api/v1/console/task-runs/:id/transcript
```

Channel integrations should use the stable TaskRun, transcript, artifact, and event-consumer routes documented in [API_V1.md](API_V1.md).
