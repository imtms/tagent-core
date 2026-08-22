# Runtime

## Boundary

The production runtime is `TAGENT_RUNTIME=in-process`, implemented by `@tagent/runtime-pi`. It adapts `pi-agent-core.AgentHarness` and `pi-ai` providers to TAgent-owned execution ports. There is no runtime RPC boundary.

All Pi-owned types are contained in the runtime adapter. `@tagent/workspace-local` supplies Execution-owned `RuntimeTool` values and `@tagent/core-service` supplies `RuntimeModelSpec`; the adapter performs the concrete Pi conversion.

Pi owns the ephemeral model/tool loop within one bounded `Attempt`. TAgent Core owns:

- durable `TaskRun` and `Attempt` identity and transitions;
- execution leases, fencing, checkpoints, transcripts, and event sequence;
- input admission, continuation limits, timeouts, cancellation, steering, and follow-up delivery;
- operation idempotency and effect receipts;
- workspace/capability policy, approvals, evidence, and final settlement.
- Skill upload, validation, immutable revisions, Session selection, and TaskRun snapshots.

The runtime cannot mark a TaskRun complete or grant itself capability.

## Dependency and compatibility boundary

Production imports of `pi-agent-core` and `pi-ai` are confined to `@tagent/runtime-pi`; other workspaces depend only on TAgent-owned execution contracts. The adapter:

- constructs an in-memory Harness Session for each Attempt;
- converts `RuntimeTool` and `RuntimeModelSpec` only at the adapter edge;
- keeps retry, fallback, compaction and accepted control delivery transcript-safe;
- resolves provider credentials by opaque reference for each outbound operation instead of retaining a plaintext key in Core configuration;
- persists the final provider-dialect request payload as a hash-verified Attempt request envelope before transport dispatch;
- keeps the Core system prompt stable for one Workspace/project-rule snapshot, reuses one large stable context per Attempt, and appends compact hash-deduplicated live-state checkpoints to the in-memory Session;
- retains failed provider messages in durable audit while excluding them from the active continuation branch at Session append time;
- enforces response-header and body-chunk idle timeouts, including zero-as-disabled mode and compaction cancellation;
- omits the optional OpenAI `store` field while preserving `pi-ai` dialect detection;
- projects only historical tool output and TaskRun receipts, preserving the complete current turn.

Architecture, package and runtime contract tests enforce this dependency boundary plus text/thinking streaming, tool ordering and guards, steering/follow-up, retry/fallback ordering, compaction, cancellation and provider transport behavior.

## Execution flow

```text
submission -> TaskRun -> execution lease -> Attempt -> AgentHarness model/tool loop
                                            |
                                            v
                 durable request envelope -> provider dispatch
                                            |
                                            v
                             candidate -> Supervisor settlement
                                            |
                      complete | continue | approval | blocked
```

Each resume, retry, or automatic continuation creates/uses the next bounded Attempt under durable authority. Continuations retain the TaskRun contract and selected durable context; they are not independent tasks.

When a TaskRun has a selected Skill, Execution passes one runtime-neutral Skill projection to `@tagent/runtime-pi`. The adapter registers it in `AgentHarness.resources.skills` and invokes `AgentHarness.skill(name, prompt)` explicitly. Skill instructions are not converted into an ordinary user prompt by Core, and they do not grant tools or bypass approval, receipts, path guards, or settlement policy.

## Context and compaction

Before an Attempt starts, Core persists an immutable Context Manifest describing selected Session messages, transcript material, TaskRun contract, prompt, Core Memory, dynamic Memory records, Cold Topics, omissions, token estimates, and a content hash. Runtime input is assembled from this manifest, not by letting the provider read the database.

The adapter imports that bounded transcript into an in-memory Harness Session. It then inserts the exact Context-Assembler-budgeted Attempt projection after imported history and before the real prompt. That stable projection contains execution policy, contract, bounded Goal/Roadmap direction, Skill metadata, and recalled Memory and is reused across the Attempt. At the first provider dispatch after the real prompt, Core appends compact mutable state—phase/status, concise plan/check/Artifact/gate state, and current external authorization—as a custom in-memory Session checkpoint; later dispatches append only when its hash changes. The provider context hook projects Session state without rebuilding or replacing the live tail, so tool-loop and no-new-input retry prefixes remain exact. Both context forms enter the real provider payload and durable request envelope; neither enters public runtime messages or the durable transcript. The adapter also projects historical tool output and TaskRun receipts, supports explicit compaction, performs threshold compaction after successful turns, and performs one compaction-and-retry cycle after a provider context-overflow response.

Compaction is session-local; the durable transcript and Context Manifest remain Core-owned. Because a summary can omit an exact path, identifier, failure code, or middle-of-output fact, `history_search` exposes bounded, case-sensitive literal search over only the current TaskRun's durable transcript. It returns at most eight newest matches with bounded snippets and cannot select another Run, regex mode, or an arbitrary result limit.

## Provider configuration

Core configuration stores only `apiCredentialReference` and a non-sensitive configured flag. The trusted composition root resolves that reference when Router, Supervisor, Roadmap, or the Pi provider performs an outbound request; the resolved value is not placed in TaskRun state, events, transcripts, request envelopes, or public runtime configuration. `TAGENT_API_KEY_ENV` may select a different environment-variable name without copying its value into `AppConfig`.

Immediately before each Pi provider call, after provider dialect conversion and every model-visible transform are complete, Runtime persists an Attempt request envelope. The exact provider request body is the single replay truth; the envelope adds only Attempt/request identity, model metadata, schema version, timestamp, and hashes rather than maintaining duplicate prompt, message, tool, Skill, or reasoning projections that could drift from the transmitted body. SQLite reads the row back and verifies both the provider-payload hash and complete envelope hash; any missing, changed, or corrupt read aborts before network dispatch. `request.envelope.persisted` exposes hashes and identity only, never authorization material.

The main runtime accepts an ordered comma-separated `TAGENT_MODEL` chain. The Web Console may select the primary model only from that configured allowlist and may set `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` reasoning; new Workspaces default to the configured primary model and `medium`. Core snapshots both values onto the TaskRun before launching its first Attempt, so recovery and continuations retain the same execution profile. Non-reasoning models are forced to `off`. A rate-limit or model-cooldown response may switch to another configured model without restarting the Attempt.

Router, Supervisor, and Workspace Goal Roadmap generation use separately bounded model, context, timeout, and output settings. Credential resolution completes before the transport response-header timer starts, so a slow trusted credential provider is not misclassified as a provider timeout. Response-header timeout, streaming body idle timeout, and credential-resolution failure remain distinct diagnostics. Their default transport timeout is 5 seconds unless the owning component documents another value. Common unambiguous admission decisions and known runtime failures are classified locally; settled semantic review follows the call policy in [SUPERVISOR.md](SUPERVISOR.md).

The runtime records provider-reported input, output, cache, total token, cost, and latency data for observability. Token totals do not override wall-clock, continuation, approval, or evidence policy. Core does not install a cumulative Run token cap or hard model/tool-call budget; `TAGENT_MAX_TOKENS` remains a per-provider-response output cap.

## Timeouts and progress

`TAGENT_RUN_TIMEOUT_MS` is an inactivity watchdog refreshed by model chunks, tool progress, and a low-frequency in-memory liveness heartbeat while a bounded tool is still running. `TAGENT_RUN_HARD_TIMEOUT_MS` is the absolute TaskRun wall-clock ceiling. Provider, Router, and Supervisor transports have their own bounded idle/retry settings. An immediate provider retry waits for the greater of Core's bounded exponential backoff and a usable provider `Retry-After` window, and the emitted `provider.retry.delayMs` is the delay actually applied. If that provider window cannot fit the Attempt watchdog budget, Core does not retry early inside the Attempt; durable continuation scheduling retains the provider window instead. OpenAI-compatible streaming requires a complete `[DONE]` sentinel; reset, malformed, incomplete, and empty responses are classified for bounded retry without copying failed partial output into the next provider request or visible transcript.

Submission, steer, and follow-up content is limited to 200,000 characters. Context assembly enforces the effective model budget even for the latest turn by projecting oversized text/tool arguments while retaining the complete durable source in SQLite or an Artifact.

Timeout or transport failure is classified through durable Attempt settlement. After bounded same-Attempt retry and configured fallback are exhausted, a provider `model_cooldown` or other retryable response with a reset duration schedules a continuation with a persisted `not_before` deadline. The continuation cannot be claimed early, survives process restart, does not count as repeated completion-gate stagnation, and may be cancelled by manual Resume. Missing user input, permission, approval, or a non-recoverable condition blocks or pauses instead of looping indefinitely. Cancellation signals are required across Runtime tools, subprocesses, workspace edits, Artifacts, Memory recall, context enrichment, and Session history. A same-process operation that has started is cooperatively cancelled and joined; a deadline never reports ownership released while that operation is still running.

## Controls

Steer and follow-up controls enter a bounded durable inbox. They are delivered to the active Harness under lease and fence without changing their mode or FIFO order: steering modifies the active response, while follow-up starts the next user turn after settlement. A follow-up that reaches the adapter-owned gap becomes the next continuation prompt rather than an internal unprompted retry. Pending delivery prevents settled completion. Abort clears and audits queued inputs. Recovery classifies an in-flight delivery conservatively when its outcome cannot be proven.

## Tools

`@tagent/workspace-local` provides contained `ls`, `read`, `write`, snapshot-bound `edit`, atomic multi-file `patch`, `bash`, and bounded same-Run `history_search` behavior plus TaskRun control integration through the Execution-owned `RuntimeTool` ABI. Concrete tools are grouped into independent Tool Providers. `ToolRegistry` rejects duplicate names and freezes an Attempt-local catalog snapshot; `ToolExecutionPipeline` is the non-bypassable path for current-Attempt fencing, external-action and Workspace Goal guards, tool-attempt records, operation receipts, idempotent replay, check invalidation, and single settlement. `runtime-pi` converts the already wrapped catalog to `AgentHarnessTool` at the adapter edge.

Tool failures retain readable model-facing text and stable machine metadata `{ name, code, message }`. The closed codes distinguish cancellation before dispatch from cancellation after invocation, timeout, path rejection, stale/precondition/argument failures, authorization denial, and unknown failure. The same metadata is persisted on tool results and projected optionally through transcript and tool lifecycle ABI for compatible clients.

`bash` delegates process creation to `SubprocessPort`. The local adapter builds a new child environment by removing all `TAGENT_*` variables and credential-shaped names (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, authorization, and cookies), then applies only explicit trusted overrides. POSIX children run in their own process group; abort, timeout, Attempt finalization, host disposal, and a main child that exits while descendants survive terminate the whole group with TERM-to-KILL escalation. Process-tree cleanup has a finite total deadline and fails explicitly rather than retaining runtime ownership forever. This is lifecycle and secret containment, not an OS sandbox.

Large output may spill to a durable Artifact with a bounded preview. The temporary capture descriptor and file are closed and removed on success and on every execution, synchronization, or Artifact-persistence failure. Successful Bash results carry a Core operation ID and digest that can bind a TaskRun check; a model-authored success claim cannot replace that receipt. Mutation-capable operations invalidate earlier trusted checks even when the mutation reports failure because partial effects cannot be assumed absent. Failed or timed-out identical Bash commands are fenced from blind re-execution, and composite commands receive split-stage guidance. The stage-aware command classifier does not treat mutation words inside quoted/read-only arguments as effects, while the catastrophic-command matcher recognizes common equivalent flag and wrapper forms. Both path containment and command policy remain guardrails, not an OS sandbox. Operation receipts and approval policy remain Core-owned even when Pi initiated the tool call.

See [EXECUTION_EFFICIENCY.md](EXECUTION_EFFICIENCY.md) for snapshot, Artifact, project-context and context-projection details.

## Web separation

The runtime does not host a browser conversation or Web assets. The independent Web Console observes and controls Core through `/api/v1` using `@tagent/core-client`.
