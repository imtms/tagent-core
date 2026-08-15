# Naming conventions

Use the same term in domain code, ports, persistence, events, ABI, tests, and documentation unless a storage convention requires snake case.

| Canonical term | Meaning | Required forms |
| --- | --- | --- |
| `TaskRun` | durable aggregate for one admitted objective | `taskRunId`, `task-runs`, `task_run.*` |
| `Attempt` | one bounded runtime execution within a TaskRun | `attemptId`, `attemptOrdinal` |
| `submission` | idempotent admission request attached to a session | `submissionId`, `Idempotency-Key` |
| `Session Inbox` | queued/deferred inputs and related work | `inboxItemId` |
| `command` | durable caller intent to control a TaskRun | command receipt, not a direct state mutation |
| `event consumer` | durable generation-fenced replay cursor | `consumerId`, `generation`, `ackedSequence` |
| `authority` | component allowed to make a canonical decision | writer, transition, approval, learning projection authority |
| `Unit of Work` | synchronous atomic multi-repository write boundary | `unitOfWork`, `uow` only in narrow local code |
| `receipt` | immutable evidence that an operation or decision occurred | explicit type prefix, identifier, timestamp |
| `Gateway` | external browser identity and channel boundary | capitalized when referring to the deployment component |

## Rules

- Use `TaskRun`, not `run`, for the aggregate in new public contracts. A runtime provider may still use “run” locally when it does not denote the aggregate.
- Use `Attempt` for a bounded execution; do not call continuations independent TaskRuns.
- Use `submission` for admission state and `message` for persisted conversation content.
- Use `Idempotency-Key` for submission idempotency. `requestId` correlates HTTP handling and is not a durable business key.
- Use `sequence` for durable ordering and `generation` for ownership fencing. Do not overload timestamps as either.
- Name ports for the capability they expose and adapters for the technology they implement.
- Name schema files by surface and major version. Keep HTTP paths plural and kebab-cased.
- Use ISO 8601 UTC timestamps in the v1 ABI and explicit units in configuration names such as `_MS`.
- Preserve domain capitalization in prose: Core, Web Console, Memory, Learning, Supervisor, Gateway, TaskRun, Attempt.

Compatibility DTO aliases, unversioned route names, and root-facade import names are not supported naming conventions.
