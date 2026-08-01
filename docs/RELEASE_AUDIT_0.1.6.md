# TAgent Core 0.1.6 Release Audit

## Scope

0.1.6 is a control-plane performance and supervision release. It reduces avoidable LLM, SQLite, SSE, checkpoint, event, and context overhead while preserving durable evidence, transcript auditability, recovery boundaries, and semantic final-delivery review.

## Primary improvements

### Runtime and control-plane performance

- Session Input Router and Supervisor use independently configurable low-latency model budgets and default to `gpt-5.6-luna`; the primary Agent model remains responsible for task execution.
- Router prompts include bounded recent Session messages, recent TaskRun summaries, and the active TaskRun contract, allowing contextual references to resolve without mechanically splitting background specifications into tasks.
- TaskRun mutations return compact receipts; full state remains available through explicit reads.
- Web event consumption batches monotonic ACKs and avoids full TaskRun reloads for ordinary tool lifecycle updates.
- Runtime text deltas are coalesced and tool progress is rate-limited before durable event/SSE publication.
- Checkpoints only track recovery-relevant events, unchanged snapshots are not rewritten, progress snapshots use the coalescing window, and transcript sequence/count access avoids repeated full-row parsing.

### Supervisor and Gate quality

- The Supervisor uses structured model judgments for progress, evidence freshness, contract coverage, completion claims, blockers, continuation viability, runtime-failure classification, and final response quality.
- Required-plan incompleteness and required-check missing/failure/staleness are authoritative deterministic prerequisites. They create complete audit receipts and continuation/evidence decisions without invoking the model.
- Semantic Supervisor review remains mandatory once deterministic prerequisites pass; the fast path does not convert a local prerequisite pass into semantic acceptance.
- Invalid structured output receives bounded correction; network/timeout/provider failures do not trigger repeated schema retries, and the lightweight reviewer has at most one configured primary-model fallback.
- Gate evaluations record evaluator/model identity, criterion receipts, rationale, confidence, failures, and evidence references.

## Compatibility and governance

- No public event type, transcript endpoint, completion criterion, operation receipt, Context Manifest, or approval boundary is removed.
- Full transcripts and terminal/tool boundary events remain durable. Event coalescing and progress sampling reduce granularity only for high-frequency intermediate updates.
- Router/Supervisor model, timeout, context-window, output-token, and reasoning settings are independently configurable through environment variables.
- The supported deployment boundary remains one trusted process/workspace on a private network or localhost, with optional PostgreSQL-backed long-term memory.

## Verification plan

The release commit must pass lint, server/Web TypeScript checks, the full Vitest suite, production build, dependency audits required by CI, release tag/version consistency, and Git drift checks. Both maintained code directories must resolve to the pushed release commit after publication.

## Documentation drift review

`package.json`, `package-lock.json`, `CHANGELOG.md`, `README.md`, `docs/STATUS.md`, and this audit identify 0.1.6 consistently. The changelog highlights the performance work and the division between deterministic Gate prerequisites and model-based semantic Supervisor judgment.
