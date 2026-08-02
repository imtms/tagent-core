# Memory-dependent Learning and controlled evolution

## Release boundary

Learning is an optional extension of long-term Memory. It covers passive observation, structured learning evidence, communication profiles, experience distillation, versioned Workflow candidates, evaluation receipts, guarded promotion and reversible governance.

Learning never modifies TAgent Core source code. It evolves data objects and runtime guidance under revision, evidence, approval and rollback controls. For the LLM semantic quality benchmark, latency/cache receipt and labeled predictions, see [SEMANTIC_MEMORY_LEARNING_EVALUATION.md](SEMANTIC_MEMORY_LEARNING_EVALUATION.md).

## Hard dependency

The invariant is:

```text
Memory off => Learning off => automatic execution off
```

`TAGENT_MEMORY_ENABLED=false` prevents Memory initialization and forces every Learning feature off. Learning APIs return `503 learning_disabled`; Workflow recall injects nothing; the Distillation Worker is stopped; no new Learning Events, observations, communication preferences, feedback attribution, candidates, approvals or execution receipts are created.

When an enabled Memory setting is changed to off through `PATCH /api/learning/settings`, Learning and automatic execution are atomically normalized to off and the Distillation Worker is stopped after any current tick settles. The persisted state survives restart. Memory itself must be configured at process startup; the runtime switch cannot create a missing PostgreSQL/Cold backend.

## Modes

| Memory | Learning | Auto execution | Effective behavior |
| --- | --- | --- | --- |
| off | forced off | forced off | no Memory or Learning code path |
| on | off | forced off | Memory only |
| on | on | off | passive observation, evidence, distillation and candidate evolution only |
| on | on | on | runtime Workflow participation is allowed, but every active action still needs human approval |

Passive operations do not write to external systems and do not activate behavior:

- Learning Event and Outcome projection;
- correction and communication evidence capture;
- Experience Observation;
- durable Distillation Jobs;
- Workflow/Revision candidates;
- evaluation evidence and quality measurement;
- conflict and proposal generation.

Active operations include Workflow activation/application, canary start and any future capability-scoped Workflow executor. They are unavailable while automatic execution is off. When it is on they still follow:

```text
request -> pending -> human approve/reject -> explicit execute -> receipt
```

The switch never bypasses TaskRun Supervisor gates, tool capability approval or Workflow governance.

## Configuration

```env
TAGENT_MEMORY_ENABLED=true
TAGENT_LEARNING_ENABLED=true
TAGENT_LEARNING_AUTO_EXECUTION_ENABLED=false
TAGENT_DISTILLATION_WORKER_INTERVAL_MS=1000

# Optional shared LLM semantic judge. It reuses the main/router provider when
# URL, key or model are omitted, and never bypasses deterministic policy.
TAGENT_LEARNING_SEMANTIC_JUDGE_ENABLED=true
TAGENT_LEARNING_SEMANTIC_JUDGE_BASE_URL=${TAGENT_ROUTER_API_BASE}
TAGENT_LEARNING_SEMANTIC_JUDGE_API_KEY=${OPENAI_API_KEY}
TAGENT_LEARNING_SEMANTIC_JUDGE_MODEL=${TAGENT_ROUTER_MODEL}
TAGENT_LEARNING_SEMANTIC_JUDGE_TIMEOUT_MS=8000
TAGENT_LEARNING_SEMANTIC_JUDGE_MIN_CONFIDENCE=0.72
TAGENT_LEARNING_SEMANTIC_JUDGE_CACHE_TTL_MS=86400000
TAGENT_LEARNING_SEMANTIC_JUDGE_MAX_CALLS_PER_MINUTE=120
```

The environment values seed a new database. Runtime state is persisted in `learning_feature_settings`; after first initialization, Web/API changes survive restart.

## LLM semantic judgment

When enabled, the shared Semantic Judge replaces brittle keyword-only decisions in the following bounded paths:

- durable Memory capture intent and extracted-record quality;
- indirect user corrections and explicit communication preferences;
- reusable procedural Learning samples and genuine failure counterexamples;
- paraphrased/cross-language experience clustering;
- common Workflow steps, verification and failure handling supported by independent Runs;
- conservative Memory-use and correction attribution.

Every task uses strict JSON validation and a confidence threshold. Exact judgments are cached in SQLite (`semantic_judgment_cache`) by task, model and input hash. Timeouts, malformed output, low confidence or the call-rate budget cannot grant capability or make a Workflow active: deterministic source policy, prompt-injection/secret checks, fresh non-empty Required Checks, independent Run support, risk/capability filtering and human approval remain authoritative. Without a configured Semantic Judge, the conservative deterministic path remains available.

Schema v23 adds the semantic cache. It may be cleared without deleting Memory, Learning Events or Workflow revisions; the next eligible input is judged again.

## API

```http
GET /api/learning/settings
PATCH /api/learning/settings
```

Example passive-only mode:

```json
{
  "memoryEnabled": true,
  "learningEnabled": true,
  "autoExecutionEnabled": false,
  "reason": "operations policy"
}
```

Example enabling execution participation:

```json
{
  "autoExecutionEnabled": true,
  "reason": "human operator enabled guarded execution"
}
```

The response always includes `activeExecutionRequiresApproval: true`.

## Web UI

The top bar shows **Learning execution** with one of three states:

- `Memory required`: switch disabled;
- `Off · passive learning only`: observation/distillation continues, active paths blocked;
- `On · approval always required`: Workflow participation allowed, active actions remain approval-gated.

Learning Center repeats the effective mode and explains its behavior boundary.

## State transitions

- Turning Memory off forces Learning and automatic execution off.
- Turning Learning off forces automatic execution off.
- Automatic execution cannot turn on unless both Memory and Learning are on.
- Turning automatic execution off does not delete evidence, candidates, revisions or audit receipts.
- Existing pending/approved requests are retained for audit but cannot execute until automatic execution is enabled again; expiration continues normally.
- Disabling Learning stops the Distillation Worker and prevents new Learning projections.

## Upgrade and migration

Schema v22 creates the singleton `learning_feature_settings` row. Schema v23 adds the durable `semantic_judgment_cache`. Existing databases migrate transactionally. Before upgrade, back up SQLite including WAL/SHM and the Memory PostgreSQL/Cold stores together.

No downgrade is supported against schema v23. Rollback requires restoring the matching pre-upgrade database backup and release artifact.

## Operations

Health/config inspection:

```sh
curl -fsS http://127.0.0.1:3220/api/health | jq
curl -fsS http://127.0.0.1:3220/api/config/status | jq
curl -fsS http://127.0.0.1:3220/api/learning/settings | jq
```

Expected passive mode:

```text
memoryEnabled=true
learningEnabled=true
autoExecutionEnabled=false
passiveLearningEnabled=true
activeExecutionRequiresApproval=true
distillation.running=true
```

Expected disabled mode:

```text
memoryEnabled=false
learningEnabled=false
autoExecutionEnabled=false
distillation.running=false
```

## Troubleshooting

- **Learning switch disabled:** Memory is unavailable or disabled. Verify `TAGENT_MEMORY_ENABLED`, PostgreSQL/Cold configuration and `/api/health`.
- **Learning API returns 503:** the hard dependency gate is active. Check `/api/learning/settings`.
- **Active action returns 409 while passive learning works:** automatic execution is off, or a valid human approval is missing/expired.
- **Distillation queue does not move:** verify Learning is enabled, Worker readiness and dead-letter metrics in `/api/health` and Learning Center.
- **Setting reverted after restart:** inspect the SQLite path used by the service and `learning_feature_settings`; environment values only seed a new database.

## Rollback and emergency disable

The safest emergency action is:

```http
PATCH /api/learning/settings
{"autoExecutionEnabled":false,"reason":"emergency passive-only mode"}
```

To stop all learning while retaining Memory:

```json
{"learningEnabled":false,"reason":"learning maintenance"}
```

To enforce the strongest boundary:

```json
{"memoryEnabled":false,"reason":"memory and learning maintenance"}
```

This also stops Learning workers and active paths. Restart is not required for the runtime gate, though backend configuration changes still require a controlled restart.
