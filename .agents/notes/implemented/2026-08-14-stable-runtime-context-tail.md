# Decision: Stable system and Attempt context with a live runtime tail

Status: implemented
Kind: architecture

## Problem

The system prompt embedded mutable TaskRun state, execution policy, Workspace Goal direction, and recalled Memory. Phase, status, Attempt, or other state changes therefore changed the earliest provider-request prefix. Moving all of that data to a per-request tail fixed the prefix, but repeated a large contract, Goal, Skill, and Memory snapshot on every provider call and allowed context budgeting to use a different recomputed string from the runtime request.

## Decision

`RunContextService.buildSystemPrompt` accepts no TaskRun or Memory arguments. Its fixed content is limited to Core instructions, the Workspace path, and the selected project-rule snapshot.

Context preparation builds one exact Attempt-stable projection containing policy, contract, bounded Workspace Goal direction, stable Skill metadata, and recalled Memory. Context assembly budgets that same string, and Execution passes it with the prepared history rather than rebuilding it at runtime. Pi inserts it once into the in-memory Session after imported history and before the real Attempt prompt. It is provider-visible and request-enveloped but absent from public runtime messages and the durable transcript.

At the first provider dispatch after the real prompt, Pi records a compact live checkpoint containing status, phase, concise plan/check/Artifact/gate state, and current external-action authorization as an in-memory custom Session entry. Later dispatches append another checkpoint only when that projection's hash changes. The Harness context hook only projects Session state; it does not rebuild or replace a request-local tail. Checkpoints are budgeted and request-enveloped but excluded from public messages and the durable transcript. Full check commands/evidence and non-target Goal/Roadmap detail remain available through Core tools and durable history instead of being repeated in each checkpoint.

## Alternatives considered

**Keep mutable state in the system prompt.** Rejected because every state change destabilizes the request prefix and stale long-lived prompts can disagree with durable authority.

**Append the entire runtime context once at Attempt start.** Rejected because tools and control events can change authoritative phase, completion, and authorization state between provider requests. Only immutable or Attempt-stable data is fixed.

**Repeat the complete durable snapshot before every request.** Rejected because it wastes context, weakens provider-prefix reuse, and can drift from the snapshot used for history budgeting.

**Persist each generated tail in transcript history.** Rejected because repeated snapshots would grow durable history and cause later requests to carry obsolete authority alongside the current projection.

## Verification

`tests/runtime.test.ts` proves the system prompt excludes Active TaskRun state and remains identical across Attempts under the same Workspace/project rules. `tests/pi-session.test.ts` proves the stable Attempt projection appears once before the real prompt, the first live checkpoint follows that prompt, changed checkpoints extend the exact provider prefix, unchanged retries remain byte-identical, and neither context form enters public or durable transcript history. `tests/context-assembler.test.ts` covers budgeting both exact strings. Package-boundary tests cover ownership.

## Consequences

Large immutable context has one Attempt-local owner and a stable provider prefix, while mutable authority advances through hash-deduplicated Session checkpoints. Project-rule or Workspace changes may still change the prefix intentionally. Compaction remains Session-local, and each changed checkpoint consumes a small bounded amount of provider context until compaction. Nested task strings in both projections remain untrusted data.
