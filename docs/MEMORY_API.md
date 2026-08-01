# Memory HTTP API, Agent Tools, and Web UI

All endpoints require memory to be enabled. If disabled, memory routes return HTTP `503` with `{"error":"memory is disabled"}`. This release assumes a trusted private deployment; callers must not treat request-provided identifiers as a substitute for an authentication layer.

## Scope and access

Memory data is isolated by a server-authorized scope:

```json
{"type":"workspace","id":"default"}
```

Supported scope types are `user`, `workspace`, `project`, and `session`. The current single-service Agent uses the configured workspace scope plus the active session scope where applicable.

## HTTP endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/memory/capture` | enqueue content/source references for durable extraction |
| `POST` | `/api/memory/jobs` | list recent capture jobs and extraction outcomes |
| `POST` | `/api/memory/status` | count records by tier/status and count topics/Cold topics |
| `POST` | `/api/memory/recall` | execute dynamic recall and return cards, Cold topics, prompt section, and trace |
| `GET` | `/api/memory/topics/:topicId` | read one complete published Cold Topic |
| `POST` | `/api/memory/records` | administratively upsert structured records/topics |
| `POST` | `/api/memory/export` | export records and readable current Cold topics for one scope |
| `POST` | `/api/memory/forget` | forget record IDs and/or Topic IDs |

Refer to `src/app.ts` and `src/memory/types.ts` for the authoritative runtime schemas and TypeScript response types.

### Capture semantics

A successful enqueue response means the request entered the durable queue; it does not mean a memory was persisted. Inspect `/api/memory/jobs`:

- `completed` with `persistedCount > 0`: memory records were persisted;
- `completed_empty`: extraction ran but generated no proposals;
- `queued` or `running`: processing is pending;
- `dead_letter`: processing exhausted retries;
- `errorCode`, `attempts`, `proposalCount`, and `persistedCount` are diagnostic fields.

### Recall semantics

Recall returns:

- `cards`: ranked Hot/Warm memory cards;
- `coldTopics`: checksum-verified complete Topic pages selected within budget;
- `promptSection`: the same low-authority section suitable for Agent injection;
- `trace`: candidate count, selected Topic IDs, and denied count.

Cold Topic bodies are not vector chunks. Topic routing happens through Warm descriptors/records, graph links, aliases, and optional semantic vectors. Recall first routes recognizable domains, applies minimum lexical/vector/Topic thresholds, removes semantic duplicates and lower-ranked contradictions, isolates identity memory to identity/name questions, and may return an empty result rather than filling Top-K with unrelated cards.

## Agent tools

When memory is enabled, the Agent receives:

### `memory_search`

Search long-term memory when automatic recall is insufficient.

```json
{"query":"Sway和乔哲住哪里","kinds":["fact"],"maxResults":8}
```

### `memory_topic_get`

Read a complete canonical Cold Topic by exact Topic ID.

```json
{"topicId":"workspace.default.fact.people.homes"}
```

### `memory_forget`

Delete/correct specific record or Topic IDs only when the user explicitly requests it.

```json
{"ids":["record-uuid"],"topicIds":["workspace.default.preference.food"]}
```

The tools call `MemoryFacade`; they do not expose SQL, object paths, or storage credentials.

## Web Memory Center

The Memory entry is rendered only when `/api/config/status` reports `memoryEnabled=true`. Memory Center uses the HTTP API to display:

- tier/status summaries;
- kind filters;
- record content, confidence/importance/strength, Topic route, and provenance;
- complete Cold Markdown pages;
- recall results and trace counts;
- capture job status;
- manual memory creation and guarded deletion.

The UI is an administrative view, not an authentication boundary.


## Record and readiness APIs

```text
GET /api/memory/records/:id?scopeType=workspace&scopeId=<id>
POST /api/memory/readiness
```

Record retrieval returns source references, provenance, status, validity and canonical semantic fields. Readiness reports backend access, worker heartbeat, capture backlog/dead letters, latest capture/consolidation timestamps, active embedding generation and index count. `/api/health` includes this readiness and returns 503 when enabled Memory is not ready.

Recall responses use `trace.version = 2` and expose lexical/vector/topic/graph/canonical routes plus score breakdown and filtering outcomes.


## Reversible forget and restore

`POST /api/memory/forget` accepts optional `reason` and `gracePeriodMs`. It returns `purgeAfter`; records are tombstoned and excluded from recall immediately, but Cold objects are not synchronously destroyed.

```json
{
  "scope": { "type": "workspace", "id": "default" },
  "ids": ["record-id"],
  "reason": "user correction",
  "gracePeriodMs": 2592000000
}
```

Restore before the deadline:

```http
POST /api/memory/restore
```

```json
{
  "scope": { "type": "workspace", "id": "default" },
  "ids": ["record-id"]
}
```

A successful restore reinstates the pre-delete status. Once maintenance physically purges the tombstone, restore returns zero restored records. Record-ID forget is reversible; Topic-ID forget remains an administrative destructive operation for the current Cold revision and should require explicit confirmation.
