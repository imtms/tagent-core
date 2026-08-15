# Decision: Structured tool errors

Status: implemented
Kind: architecture

## Problem

The Pi loop converts thrown tool errors to plain text, losing cancellation phase, path rejection, authorization, and timeout identity before transcript or event consumers can route the failure.

## Decision

Execution owns a stable `{ name, code, message }` error shape and a closed code set. Lifecycle and policy use `ABORTED_BEFORE_DISPATCH`, `ABORTED`, `TIMEOUT`, `PATH_REJECTED`, `NOT_AUTHORIZED`, and `UNKNOWN`; optimistic edit failures retain actionable identity through `STALE_STATE`, `PRECONDITION_FAILED`, and `INVALID_ARGUMENT`.

The tool pipeline classifies provider errors and records structured failure evidence on operation receipts. The Pi adapter converts a thrown classified error into result details, forces `isError`, and preserves metadata on tool transcript messages and lifecycle events. Public Channel schemas expose the field only where a failed tool result carries structured error identity.

## Alternatives considered

**Parse error text in each consumer.** Rejected because string heuristics drift and cannot reliably distinguish lifecycle phases.

**Expose adapter-specific exception objects.** Rejected because stacks, prototypes, and private fields are unstable and not JSON transport contracts.

**Change model-facing error text into JSON.** Rejected because routing metadata is for code and replay; readable text remains useful to the model.

## Verification

Pipeline tests assert stable codes and structured operation effects. Pi integration tests assert the same metadata in tool results, transcript views, and `tool.completed` events. ABI typechecking verifies the optional public schema.

## Consequences

Consumers can route stable codes without substring matching. Unknown failures remain explicit, and adding a code now requires a deliberate contract change.
