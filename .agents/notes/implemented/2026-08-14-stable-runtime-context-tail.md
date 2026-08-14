# Decision: Stable system prompt with dynamic runtime tail

Status: implemented
Kind: architecture

## Problem

The system prompt embedded mutable TaskRun state, execution policy, Workspace Goal direction, and recalled Memory. Phase, status, Attempt, or other state changes therefore changed the earliest provider-request prefix. Resume prompts also duplicated the durable snapshot, while a long-lived Harness could retain a stale copy instead of refreshing current Core state.

## Decision

`RunContextService.buildSystemPrompt` accepts no TaskRun or Memory arguments. Its fixed content is limited to Core instructions, the Workspace path, and the selected project-rule snapshot. `buildRuntimeDynamicContext` owns current TaskRun, policy, Workspace Goal, and recalled-Memory projection.

Immediately before every Pi provider request, the Harness context hook reloads current durable state and appends that projection as one ephemeral final user message after projected history. Context assembly reserves the tail's token budget. The real provider payload and schema-45 request envelope include the tail, but the Harness Session and durable transcript do not persist it.

## Alternatives considered

**Keep mutable state in the system prompt.** Rejected because every state change destabilizes the request prefix and stale long-lived prompts can disagree with durable authority.

**Append the dynamic context once at Attempt start.** Rejected because tools and control events can change authoritative state between provider requests.

**Persist each generated tail in transcript history.** Rejected because repeated snapshots would grow durable history and cause later requests to carry obsolete authority alongside the current projection.

## Verification

`tests/runtime.test.ts` proves the system prompt excludes Active TaskRun state and remains identical across Attempts under the same Workspace/project rules. `tests/pi-session.test.ts` proves the tail refreshes on every request, is last in the transmitted payload and request envelope, and is absent from persisted runtime messages. Context and package-boundary tests cover budgeting and ownership. The full `npm test` suite passes.

## Consequences

Mutable runtime data has one request-local owner and cannot accidentally re-enter the fixed prompt through the removed parameters. Project-rule or Workspace changes may still change the prefix intentionally. The dynamic message consumes provider context on every request and is explicitly treated as Core-generated context whose nested task strings are untrusted data.
