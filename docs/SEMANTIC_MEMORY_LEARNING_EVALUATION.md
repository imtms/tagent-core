# LLM Semantic Memory & Learning Evaluation

## 1. Evaluation receipt

- Evaluation command: `cd dev && npx tsx scripts/evaluate-semantic-memory-learning.ts`
- Result artifact: `docs/semantic-memory-learning-evaluation-results.json`
- Artifact SHA-256: `f00f9f0046800ffa4ff16c4d77c73e549b08c488fe6ae88bfd6e517b228f8322`
- Evaluated provider/model: `one.tms.im / gpt-5.6-sol`
- Dataset size: 28 labeled semantic decisions:
  - 12 Memory capture samples: 6 durable, 6 non-durable
  - 10 correction samples: 5 corrections, 5 non-corrections
  - 6 clustering pairs: 3 same-intent, 3 different-intent
- Labels and every model prediction are preserved in the JSON artifact.
- The fixture is a traceable curated regression set assembled from the failure modes represented in repository tests and the task requirements. It is not claimed to be a statistically representative production corpus. The checked local `dev/data/tagent.db` contained no user messages, so no unavailable “production history” was invented.

## 2. Quantitative before/after results

### Memory capture intent

The baseline is the pre-existing `RuleBasedExtractor`: a sample counts as captured when it emits at least one record. The semantic result is `SemanticJudge.memoryCapture()` after schema and confidence validation.

| Metric | Keyword/rule baseline | LLM semantic | Absolute change |
|---|---:|---:|---:|
| Accuracy | 41.7% (5/12) | 91.7% (11/12) | +50.0 pp |
| Durable-memory recall / coverage | 16.7% (1/6) | 100.0% (6/6) | +83.3 pp |
| Precision | 33.3% (1/3) | 85.7% (6/7) | +52.4 pp |
| False-positive rate / miscapture | 33.3% (2/6) | 16.7% (1/6) | -16.7 pp |
| False negatives | 5 | 0 | -5 |
| False positives | 2 | 1 | -1 |

The remaining semantic false positive is the advisory/hypothetical statement `你可以考虑以后换成 PostgreSQL。`; it is retained in the artifact so the limitation is visible rather than hidden.

### Natural-language correction detection

The baseline is the exact correction regex previously used by `AgentService`. The semantic result is `SemanticJudge.userMessage()`.

| Metric | Keyword/regex baseline | LLM semantic | Absolute change |
|---|---:|---:|---:|
| Accuracy | 50.0% (5/10) | 100.0% (10/10) | +50.0 pp |
| Correction recall | 0.0% (0/5) | 100.0% (5/5) | +100.0 pp |
| Precision | 0.0% | 100.0% (5/5) | +100.0 pp |
| False-positive rate | 0.0% (0/5) | 0.0% (0/5) | unchanged |

The positive cases intentionally avoid the old trigger phrases and include indirect Chinese and English corrections.

### Experience clustering

Six Chinese/English and paraphrased task pairs were evaluated through `SemanticJudge.cluster()`:

- Accuracy: 100.0% (6/6)
- Recall: 100.0% (3/3)
- Precision: 100.0% (3/3)
- False-positive rate: 0.0% (0/3)

The service still keeps the deterministic high-confidence local similarity fast path and uses LLM judgment only for lower-overlap candidates.

## 3. Latency, cache and cost

Measured over the 28 uncached live semantic calls:

| Metric | Result |
|---|---:|
| Provider calls | 28 |
| Uncached average latency | 3,648 ms/call |
| Uncached p50 latency | 3,265 ms |
| Uncached p95 latency | 5,733 ms |
| Failures | 0 |
| Timeouts | 0 |
| Low-confidence withholds | 0 |
| Input tokens | 12,454 |
| Output tokens | 2,731 |

Cache replay then repeated all 12 Memory inputs:

| Cache metric | Result |
|---|---:|
| Replay inputs | 12 |
| Cache hits | 12/12 (100%) |
| Additional provider calls | 0 |
| Total replay wall time | 0.423 ms |
| Average cached lookup | 0.035 ms/input |

This demonstrates why the durable cache is necessary: uncached semantic calls are materially slower than deterministic rules, while exact duplicates avoid provider latency and token cost.

The JSON artifact reports an estimated `$0.011689` for this 28-call run using the evaluator's configured accounting rates of `$0.50/M` input tokens and `$2.00/M` output tokens. This is an accounting estimate, not a provider invoice. The implementation exposes token counts independently so deployment-specific rates can replace those assumptions.

## 4. Production build receipt

Command: `cd dev && npm run build`

- Exit code: 0
- End-to-end measured shell elapsed time: 20,001 ms
- Vite portion: 4.92 s
- Modules transformed: 1,784
- JS bundle: 483.30 kB, gzip 159.87 kB
- CSS bundle: 61.25 kB, gzip 12.48 kB

## 5. Regression verification receipts

- Focused Memory/Learning semantic suite: 7 files passed; 48 tests passed; 1 optional live-LLM test skipped.
- Full test suite: 35 files passed, 1 skipped; 364 tests passed, 3 skipped.
- Server/Web TypeScript: passed.
- ESLint: passed with zero warnings.
- `git diff --check`: passed.

## 6. Implemented governance

The shared `SemanticJudge` now covers Memory capture intent and quality, natural-language corrections and communication preferences, reusable sample selection, counterexample judgment, semantic clustering, common-step/verification distillation, and conservative Memory attribution.

Controls:

- strict task-specific JSON validation;
- default confidence gate `0.72`;
- default timeout `8s`;
- default rate budget `120 calls/minute`;
- durable cache keyed by task + model + input hash, default TTL 24h;
- metrics for calls, cache hits, failures, timeouts, low confidence, latency, tokens and estimated cost;
- invalid, timed-out and low-confidence quality decisions are withheld;
- deterministic fallback remains available when no Semantic Judge is configured;
- deterministic safety, provenance, permissions, fresh required checks, independent-run support, risk/capability gates and human approval remain authoritative.

## 7. Configuration

```env
TAGENT_LEARNING_SEMANTIC_JUDGE_ENABLED=true
TAGENT_LEARNING_SEMANTIC_JUDGE_BASE_URL=${TAGENT_ROUTER_API_BASE}
TAGENT_LEARNING_SEMANTIC_JUDGE_API_KEY=${OPENAI_API_KEY}
TAGENT_LEARNING_SEMANTIC_JUDGE_MODEL=${TAGENT_ROUTER_MODEL}
TAGENT_LEARNING_SEMANTIC_JUDGE_TIMEOUT_MS=8000
TAGENT_LEARNING_SEMANTIC_JUDGE_MIN_CONFIDENCE=0.72
TAGENT_LEARNING_SEMANTIC_JUDGE_CACHE_TTL_MS=86400000
TAGENT_LEARNING_SEMANTIC_JUDGE_MAX_CALLS_PER_MINUTE=120
```

## 8. Release boundary

The evaluation was captured before release; deployment evidence is recorded in RELEASE_AUDIT_0.1.11.md. Workflow activation, revision application, canary start and active execution continue to require the existing human-approval path.
