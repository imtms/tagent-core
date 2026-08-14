# Decision: Bounded literal recall for compacted history

Status: implemented
Kind: feature

## Problem

Compaction summaries and historical tool-result projection can omit exact earlier facts. TAgent already tells the model that a projected tool result remains in the durable transcript, but previously exposed no way to retrieve a known path, identifier, failure code, or middle-of-output literal. Adding a broad history-query suite without evidence would increase every Attempt's tool surface and create unnecessary pagination, authorization, and prompt costs.

## Decision

TAgent exposes one `history_search` tool over the current TaskRun's durable transcript. It performs case-sensitive literal matching, returns newest matches first, and has fixed product bounds of eight matches and 320 source characters per snippet. The model supplies only the literal query; it cannot choose a Run, sequence range, output limit, regex, or semantic query. Search derives the Run from the fenced Attempt capability and excludes the current assistant tool-call message with an exclusive sequence boundary.

`TranscriptRepository.searchTranscriptLiteral` is the storage-neutral seam. SQLite uses `instr(message_json, ?)` with a JSON-escaped literal, so `%` and `_` have no wildcard meaning and quotes match their durable encoding. Synchronous database work is bracketed by the caller-owned required `AbortSignal`. The workspace tool provider formats bounded results with their sequence, Attempt, role, timestamp, truncation status, and search boundary.

The deterministic offline benchmark in `benchmarks/compaction-summary-loss.json` and `scripts/compaction-summary-loss-benchmark.mjs` is the decision gate. Its fixed RuntimeMessage-shaped corpus covers paths, identifiers, failure codes, decisions, unresolved work, facts in the middle of long tool results, preferences, migration invariants, literal wildcard characters, and test evidence. It measures exact-fact recall and character cost without claiming to estimate a particular provider model.

## Alternatives considered

**Add `history_read` and `history_search`.** Rejected because the benchmark shows literal search can recover every suspected exact fact without exposing sequence-range pagination or returning full transcript spans. A read tool needs separate evidence that search snippets cannot support a real workflow.

**Add cross-session or semantic search.** Rejected because compaction loss is a same-TaskRun problem and exact durable text already exists. Cross-session authority and a derived index belong to separate opt-in decisions; embeddings would sacrifice keyless deterministic replay.

**Trust summaries and projection markers.** Rejected because a marker that says full content remains durable is not actionable without a retrieval path, and the benchmark demonstrates exact loss in every non-decision fact class.

**Inject the full transcript.** Rejected because it defeats compaction and makes retrieval cost unbounded.

## Verification

Run `npm run benchmark:compaction`. The version-one corpus contains 13 facts: summary exact-fact recall is `0.231`, durable literal-search recall is `1.000`, the full transcript costs 23,411 characters, and all bounded search results cost 5,247 characters (`0.224` of the full transcript). The report states its synthetic-corpus, exact-query, character-estimation, and sample-size limitations and emits `add_history_search_only` only when the checked thresholds pass.

`tests/store.test.ts` pins literal `%` and `_`, JSON-escaped quotes, case sensitivity, newest-first order, exclusive sequence scope, truncation, and snippet bounds. `tests/tools.test.ts` pins the absence of model-supplied Run authority, current-message exclusion, fixed result bounds, durable tool-attempt settlement, and caller cancellation. Type checks cover the repository, composition, and tool capability seams.

## Consequences

A model that suspects an omitted exact fact can recover it at bounded cost without accessing another Run or adding a derived index. One concise schema is present in each production Attempt, and literal search cannot discover an unknown paraphrase or decide when recall is needed. The benchmark is deliberately a regression fixture rather than a model-quality claim; production-safe cases should extend it. `history_read`, regex, semantic retrieval, cross-session search, and frozen index checkpoints remain out of scope until separate evidence justifies their surface area.
