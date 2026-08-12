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

The runtime cannot mark a TaskRun complete or grant itself capability.

## Dependency and compatibility boundary

Production imports of `pi-agent-core` and `pi-ai` are confined to `@tagent/runtime-pi`; other workspaces depend only on TAgent-owned execution contracts. The adapter:

- constructs an in-memory Harness Session for each Attempt;
- converts `RuntimeTool` and `RuntimeModelSpec` only at the adapter edge;
- keeps retry, fallback, compaction and accepted control delivery transcript-safe;
- retains failed provider messages in durable audit while removing them from the active continuation branch;
- enforces response-header and body-chunk idle timeouts, including zero-as-disabled mode and compaction cancellation;
- omits the optional OpenAI `store` field while preserving `pi-ai` dialect detection;
- projects only historical tool output and TaskRun receipts, preserving the complete current turn.

Architecture, package and runtime contract tests enforce this dependency boundary plus text/thinking streaming, tool ordering and guards, steering/follow-up, retry/fallback ordering, compaction, cancellation and provider transport behavior.

## Execution flow

```text
submission -> TaskRun -> execution lease -> Attempt -> AgentHarness model/tool loop
                                            |
                                            v
                             candidate -> Supervisor settlement
                                            |
                      complete | continue | approval | blocked
```

Each resume, retry, or automatic continuation creates/uses the next bounded Attempt under durable authority. Continuations retain the TaskRun contract and selected durable context; they are not independent tasks.

## Context and compaction

Before an Attempt starts, Core persists an immutable Context Manifest describing selected Session messages, transcript material, TaskRun contract, prompt, Core Memory, dynamic Memory records, Cold Topics, omissions, token estimates, and a content hash. Runtime input is assembled from this manifest, not by letting the provider read the database.

The adapter imports that bounded transcript into an in-memory Harness Session. It projects historical tool output and TaskRun receipts before provider calls, supports explicit compaction, performs threshold compaction after successful turns, and performs one compaction-and-retry cycle after a provider context-overflow response. Compaction is session-local; the durable transcript and Context Manifest remain Core-owned.

## Provider configuration

The main runtime accepts an ordered comma-separated `TAGENT_MODEL` chain. The Web Console may select the primary model only from that configured allowlist and may set `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` reasoning; new Workspaces default to the configured primary model and `medium`. Core snapshots both values onto the TaskRun before launching its first Attempt, so recovery and continuations retain the same execution profile. Non-reasoning models are forced to `off`. A rate-limit response may switch to another configured model without restarting the Attempt.

Router and Supervisor use separately bounded model, context, timeout, and output settings. Their default transport timeout is 5 seconds. Common unambiguous admission decisions and known runtime failures are classified locally; settled semantic review follows the call policy in [SUPERVISOR.md](SUPERVISOR.md).

The runtime records provider-reported input, output, cache, total token, cost, and latency data for observability. Token totals do not override wall-clock, continuation, approval, or evidence policy. Core does not install a cumulative Run token cap or hard model/tool-call budget; `TAGENT_MAX_TOKENS` remains a per-provider-response output cap.

## Timeouts and progress

`TAGENT_RUN_TIMEOUT_MS` is an inactivity watchdog refreshed by model chunks, tool progress, and a low-frequency in-memory liveness heartbeat while a bounded tool is still running. `TAGENT_RUN_HARD_TIMEOUT_MS` is the absolute TaskRun wall-clock ceiling. Provider, Router, and Supervisor transports have their own bounded idle/retry settings.

Submission, steer, and follow-up content is limited to 200,000 characters. Context assembly enforces the effective model budget even for the latest turn by projecting oversized text/tool arguments while retaining the complete durable source in SQLite or an Artifact.

Timeout or transport failure is classified through durable Attempt settlement. A transient failure may schedule a bounded continuation; missing user input, permission, approval, or a non-recoverable condition blocks or pauses instead of looping indefinitely.

## Controls

Steer and follow-up controls enter a bounded durable inbox. They are delivered to the active Harness under lease and fence. Pending delivery prevents settled completion. Abort clears and audits queued inputs. Recovery classifies an in-flight delivery conservatively when its outcome cannot be proven.

## Tools

`@tagent/workspace-local` provides contained `ls`, `read`, `write`, snapshot-bound `edit`, atomic multi-file `patch`, and `bash` behavior plus TaskRun control integration through the Execution-owned `RuntimeTool` ABI. `runtime-pi` converts those tools to `AgentHarnessTool` at the adapter edge.

Large output may spill to a durable Artifact with a bounded preview. Successful Bash results carry a Core operation ID and digest that can bind a TaskRun check; a model-authored success claim cannot replace that receipt. Failed or timed-out identical Bash commands are fenced from blind re-execution, and composite commands receive split-stage guidance. Path containment and command policy are guardrails, not an OS sandbox. Operation receipts and approval policy remain Core-owned even when Pi initiated the tool call.

See [EXECUTION_EFFICIENCY.md](EXECUTION_EFFICIENCY.md) for snapshot, Artifact, project-context and context-projection details.

## Web separation

The runtime does not host a browser conversation or Web assets. The independent Web Console observes and controls Core through `/api/v1` using `@tagent/core-client`.
