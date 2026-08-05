# Learning

## Boundary

`@tagent/learning` owns optional passive evidence, communication profiles, experience distillation, versioned Workflow candidates, evaluation, and governed activation. Learning changes durable data and runtime guidance; it does not rewrite TAgent Core source code.

Learning has a hard dependency on Memory:

```text
Memory off => Learning off => automatic execution off
```

## Modes

| Memory | Learning | Automatic execution | Effective behavior |
| --- | --- | --- | --- |
| off | forced off | forced off | no Memory or Learning initialization |
| on | off | forced off | Memory only |
| on | on | off | passive observation, evidence, distillation, and candidates |
| on | on | on | Workflow participation allowed; active actions still require approval |

Passive work includes projection of lifecycle evidence, corrections, communication preferences, experience observations, distillation jobs, Workflow/revision candidates, evaluation evidence, and conflict proposals.

Active work includes Workflow activation/application, canary actions, binding application, and capability-bearing execution. The switch never bypasses Governance approval, capability policy, TaskRun settlement, or operation receipts.

## Configuration

```env
TAGENT_MEMORY_ENABLED=true
TAGENT_LEARNING_ENABLED=true
TAGENT_LEARNING_AUTO_EXECUTION_ENABLED=false
TAGENT_DISTILLATION_WORKER_INTERVAL_MS=1000

TAGENT_LEARNING_SEMANTIC_JUDGE_ENABLED=false
TAGENT_LEARNING_SEMANTIC_JUDGE_BASE_URL=
TAGENT_LEARNING_SEMANTIC_JUDGE_API_KEY=
TAGENT_LEARNING_SEMANTIC_JUDGE_MODEL=
TAGENT_LEARNING_SEMANTIC_JUDGE_TIMEOUT_MS=8000
TAGENT_LEARNING_SEMANTIC_JUDGE_MIN_CONFIDENCE=0.72
```

Environment values seed a new database. Runtime feature settings are persisted and survive restart. Turning Learning off forces automatic execution off; turning Memory off forces both off.

## Schema 33 integration authority

Schema 33 separates Learning consumption from Execution persistence through an immutable integration journal and fenced delivery state. Execution publishes canonical lifecycle evidence through a generic integration port inside the same writer-fenced transaction as the TaskRun/Attempt event.

The persistence adapter retains migration-window legacy and integration projections, checkpoints, reconciliation, effect receipts, and a single active authority. Only the active generation/source may claim and ACK. Shadow consumption may compare results but cannot apply effects.

Cutover requires a contiguous watermark, drained leases, matching reconciliation, a new authority generation, and replay evidence. Rollback resumes from the stored watermark and uses effect receipts to avoid repeating committed effects. Do not delete legacy migration paths merely because their name contains “legacy”; removal requires a separately evidenced deprecation gate.

## Approval and no-bypass rule

Learning may create proposals, requests, evaluations, and receipts. It cannot directly mutate TaskRun authority or execute a capability without Governance approval. Approval resolution and active effect receipt are separate durable steps.

The shared Semantic Judge may classify reusable evidence and cross-language similarity, but low-confidence or malformed output cannot activate a Workflow, grant capability, or weaken deterministic checks.

## Admin surface

Versioned admin routes include:

```text
GET/PATCH /api/v1/admin/learning/settings
GET/PATCH /api/v1/admin/console/learning/settings
GET       /api/v1/admin/sessions/:id/learning-center
POST      /api/v1/admin/workflows/:id/activation-request
POST      /api/v1/admin/workflows/:id/activate
POST      /api/v1/admin/workflows/:id/suspend
POST      /api/v1/admin/workflow-proposals/:id/*
POST      /api/v1/admin/autonomy-approvals/:id/*
POST      /api/v1/admin/workflow-distillation/*
```

Use `@tagent/abi/admin/v1` and the Web Console's Core client integration for exact payloads. Governance routes require `workflows:govern` or `workflows:approve`; general configuration requires `admin` when credentials are enabled.

## Operations

Monitor:

- effective Memory/Learning/automatic-execution settings;
- distillation worker running/ready state;
- integration and legacy checkpoints, authority generation, and reconciliation;
- failed/leased deliveries and effect receipts;
- pending or expired approval requests;
- harmful feedback, suspended Workflows, and canary results.

The fastest emergency containment is to disable automatic execution, leaving passive evidence intact. Disable Learning to stop new projection/distillation work while retaining Memory. Disable Memory for the strongest feature boundary; Core normalizes Learning and automatic execution off.

Before an upgrade or authority switch, back up SQLite and Memory together and record all watermarks. See [PERSISTENCE_AND_RECOVERY.md](PERSISTENCE_AND_RECOVERY.md).
