# TAgent Core 0.1.12 Release Audit

## Scope

0.1.12 releases the LLM-semantic Memory/Learning quality upgrade. It does not change the existing Memory dependency, passive-learning switch, human approval, capability, risk, Supervisor or rollback boundaries.

## Semantic judgment boundary

The shared `SemanticJudge` is optional and schema validated. When enabled it assists:

- durable Memory capture intent and extracted-record quality;
- indirect correction and explicit communication-preference detection;
- reusable Learning sample and genuine counterexample selection;
- paraphrased and cross-language experience clustering;
- Workflow common-step, common-verification and failure-handling distillation;
- conservative Memory-use and correction attribution.

The model is not authoritative for secrets, prompt injection, source policy, provenance, fresh non-empty Required Checks, independent Run counts, risk/capability policy, activation, promotion or execution approval. Invalid, timed-out or low-confidence output is withheld or falls back to the conservative deterministic path.

## Efficiency and persistence

- Schema 23 adds `semantic_judgment_cache`, keyed by semantic task, model and input hash.
- Default cache TTL: 24 hours.
- Default timeout: 8 seconds.
- Default minimum confidence: 0.72.
- Default call budget: 120 calls per minute.
- Metrics record calls, cache hits, failures, timeouts, low-confidence withholds, latency, tokens and estimated cost.
- Capture jobs now distinguish extractor-zero results from quality-filtered results and aggregate filter reasons.

## Distillation quality

Workflow candidates require:

1. at least two independent successful Runs;
2. common executable steps supported across the required Run threshold;
3. verification checks passed by every successful Run.

The service no longer copies the first Run when common steps are absent. Waiting-input or interruption outcomes without concrete failed checks are not treated as procedure counterexamples.

## Evaluation evidence

The reproducible evaluator is `scripts/evaluate-semantic-memory-learning.ts`. The release artifact in the source workspace records 28 labeled live-model decisions covering Memory capture, natural-language corrections and cross-language task clustering. The curated fixture is a regression set, not a statistically representative production corpus.

Recorded result artifact:

- `semantic-memory-learning-evaluation-results.json`
- SHA-256: `f00f9f0046800ffa4ff16c4d77c73e549b08c488fe6ae88bfd6e517b228f8322`

Summary:

- Memory capture accuracy: 41.7% rule baseline -> 91.7% semantic;
- correction accuracy: 50.0% regex baseline -> 100.0% semantic;
- clustering accuracy: 100.0% on 6 labeled pairs;
- exact replay cache: 12/12 hits with no additional provider calls.

## Compatibility

- Package version: `0.1.12`.
- SQLite schema: `23`.
- Existing Schema 22 databases migrate transactionally.
- Back up SQLite including WAL/SHM and Memory PostgreSQL/Cold stores before deployment.
- Downgrade requires restoring the matching pre-upgrade SQLite backup and release artifact.

## Production configuration

The 3220 release enables the judge while preserving passive-only Workflow execution:

```env
TAGENT_MEMORY_ENABLED=true
TAGENT_LEARNING_ENABLED=true
TAGENT_LEARNING_AUTO_EXECUTION_ENABLED=false
TAGENT_LEARNING_SEMANTIC_JUDGE_ENABLED=true
TAGENT_LEARNING_SEMANTIC_JUDGE_BASE_URL=${TAGENT_API_BASE}
TAGENT_LEARNING_SEMANTIC_JUDGE_API_KEY=${OPENAI_API_KEY}
TAGENT_LEARNING_SEMANTIC_JUDGE_MODEL=${TAGENT_MODEL}
```

## Release gates

- Server and Web TypeScript checks;
- ESLint with zero warnings;
- focused Memory/Learning semantic tests;
- full Vitest suite;
- production server/Web build;
- `git diff --check`;
- immutable Linux x64 Node 24 ABI 137 release artifact and manifest verification;
- 3220 restart and health/version/Memory/Learning Worker verification.
