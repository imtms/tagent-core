# Runtime

## Boundary

The production runtime is `TAGENT_RUNTIME=in-process`, implemented by `@tagent/runtime-pi`. It adapts Pi `AgentSession` to TAgent-owned execution ports. There is no runtime RPC boundary in 0.2.0.

Pi owns the ephemeral model/tool loop within one bounded `Attempt`. TAgent Core owns:

- durable `TaskRun` and `Attempt` identity and transitions;
- execution leases, fencing, checkpoints, transcripts, and event sequence;
- input admission, continuation limits, timeouts, cancellation, steering, and follow-up delivery;
- operation idempotency and effect receipts;
- workspace/capability policy, approvals, evidence, and final settlement.

The runtime cannot mark a TaskRun complete or grant itself capability.

## Execution flow

```text
submission -> TaskRun -> execution lease -> Attempt -> Pi model/tool loop
                                            |
                                            v
                             candidate -> Supervisor settlement
                                            |
                      complete | continue | approval | blocked
```

Each resume, retry, or automatic continuation creates/uses the next bounded Attempt under durable authority. Continuations retain the TaskRun contract and selected durable context; they are not independent tasks.

## Context

Before an Attempt starts, Core persists an immutable Context Manifest describing selected Session messages, transcript material, TaskRun contract, prompt, Core Memory, dynamic Memory records, Cold Topics, omissions, token estimates, and a content hash. Runtime input is assembled from this manifest, not by letting the provider read the database.

## Provider configuration

The main runtime accepts an ordered comma-separated `TAGENT_MODEL` chain. A rate-limit response may switch to the next model without restarting the Attempt. Router and Supervisor use separately bounded model, context, timeout, and output settings.

The runtime records provider-reported input, output, cache, total token, cost, and latency data for observability. Token totals do not override wall-clock, continuation, approval, or evidence policy.

## Timeouts and progress

`TAGENT_RUN_TIMEOUT_MS` is an inactivity watchdog refreshed by model chunks and tool progress. `TAGENT_RUN_HARD_TIMEOUT_MS` is the absolute TaskRun wall-clock ceiling. Provider, Router, and Supervisor transports have their own bounded idle/retry settings.

Timeout or transport failure is classified through durable Attempt settlement. A transient failure may schedule a bounded continuation; missing user input, permission, approval, or a non-recoverable condition blocks or pauses instead of looping indefinitely.

## Controls

Steer and follow-up controls enter a bounded durable inbox. They are delivered to the active runtime under lease and fence. Pending delivery prevents settled completion. Recovery classifies an in-flight delivery conservatively when its outcome cannot be proven.

## Tools

`@tagent/workspace-local` provides contained `ls`, `read`, `write`, `edit`, and `bash` behavior plus TaskRun control integration. Path containment and command policy are guardrails, not an OS sandbox. Operation receipts and approval policy remain Core-owned even when Pi initiated the tool call.

## Web separation

The runtime does not host a browser conversation or Web assets. The independent Web Console observes and controls Core through `/api/v1` using `@tagent/core-client`.
