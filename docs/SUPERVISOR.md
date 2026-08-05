# Supervisor

## Authority

The TaskRun Supervisor governs settlement; the Agent runtime cannot declare durable success by itself. Assistant output streamed during an Attempt is provisional until the Supervisor accepts the candidate and Core persists it as the Session answer.

## Deterministic floor

Before semantic review, Core checks authoritative prerequisites:

- the TaskRun has a contract and required plan state where applicable;
- every required plan item is complete;
- every required check has a passing receipt;
- verification evidence is newer than the last relevant workspace mutation;
- required approvals and operation receipts exist;
- the delivery is non-empty and not provider-truncated;
- no durable steer/follow-up remains pending delivery.

A semantic reviewer cannot convert a failed deterministic prerequisite into success.

## Settled review

For substantial work, the Supervisor produces a schema-validated audit of progress, evidence, contract coverage, completion, and continuation. Every acceptance criterion receives one of:

```text
covered | unsupported | contradicted | blocked
```

Evidence references may point only to durable checks, artifacts, operations, or Memory records/revisions supplied to the review. Candidate prose is not independent proof of its own claims.

A narrow low-risk single-answer discussion may use deterministic lightweight completion when it has no side effects, required checks, artifacts, truncation, or risky release/security semantics.

## Actions

| Action | Meaning |
| --- | --- |
| `complete_taskrun` | persist the candidate as the final Session answer |
| `request_evidence` | continue specifically to produce missing verification evidence |
| `start_continuation` | start bounded repair or completion work |
| `pause_for_approval` | create/retain a durable approval request; do not auto-continue |
| `wait_for_runtime` | wait for pending durable control delivery |
| `block_taskrun` | stop on missing user/external state or non-recoverable failure |
| `steer` / `follow_up` | bounded intervention while an Attempt is active |

If a candidate is rejected, Core emits/persists rejection state, keeps the candidate in the TaskRun transcript for audit, and does not append it as the final chat answer. The next continuation must produce a complete standalone replacement.

## Attempt-terminal review

Runtime failures are classified separately from settled candidate quality. Transient provider/network failures may continue; approval or permission failures pause; missing parameters and non-transient failures block. Bounded retry policy prevents an unavailable Supervisor from causing an unbounded Agent loop.

## Approval boundary

The Supervisor may request approval but cannot approve its own action. Governance owns canonical approval receipts. Early parallel related-task starts, high-impact operations, and active Learning actions remain subject to their explicit capability and approval policies.

## Inspection

The Web Console reads versioned console projections:

```text
GET /api/v1/console/task-runs/:id
GET /api/v1/console/task-runs/:id/context-manifests
GET /api/v1/console/task-runs/:id/transcript
```

Channel integrations should use the stable TaskRun, transcript, artifact, and event-consumer routes documented in [API_V1.md](API_V1.md).
