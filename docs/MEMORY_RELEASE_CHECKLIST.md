# Memory Feature Release Checklist

Use this in addition to [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).

## 1. Documentation and scope

- [ ] `docs/MEMORY.md` links to architecture, operations, API/UI, design baseline, and this checklist.
- [ ] README states memory is optional and disabled by default.
- [ ] Architecture describes implemented behavior, not planned behavior as complete.
- [ ] Known limitations explicitly include trusted/private deployment and incomplete multi-tenant authentication.
- [ ] `.env.example` contains every `TAGENT_MEMORY_*` variable used by code and no real credential.
- [ ] Changelog and development status describe the memory release.

## 2. Memory-off compatibility gate

With no PostgreSQL and `TAGENT_MEMORY_ENABLED=false`:

- [ ] server starts;
- [ ] `/api/health`, sessions, runs, SQLite persistence, and Web workbench function;
- [ ] no memory adapter/worker is initialized;
- [ ] no Local Cold path is created/read;
- [ ] Memory UI entry is hidden;
- [ ] memory APIs return HTTP 503.

## 3. Durable Local Cold gate

Start PostgreSQL/pgvector from `deploy/postgres/compose.yml`, enable the PostgreSQL + Local Cold profile, and verify:

- [ ] migration creates `vector`, `pg_trgm`, and all `memory.*` tables/indexes;
- [ ] capture jobs claim, lease, complete, retry, and expose zero-proposal/dead-letter state;
- [ ] facts and preferences persist in separate tables;
- [ ] Hot records promote to Warm;
- [ ] Topic Descriptor and graph routing operate;
- [ ] eligible Warm records publish an immutable Cold revision;
- [ ] the current revision checksum is verified and the complete page is returned;
- [ ] no `cold_body` vector can be inserted;
- [ ] restart preserves PostgreSQL records/jobs/topics and Local Cold pages;
- [ ] backup/restore smoke test preserves readable current revisions.

## 4. Semantic quality gate

Using the intended real embedding and hybrid extractor providers:

- [ ] embedding batch, timeout, retry, generation, and lexical fallback are verified;
- [ ] extractor credentials are loaded without logging them;
- [ ] explicit identity is recalled exactly;
- [ ] positive and negative preferences are distinguished;
- [ ] conversation coreference is resolved for the maintained Chinese cases;
- [ ] assistant guesses and TaskRun wrapper text do not become user facts;
- [ ] unsupported input becomes observable `completed_empty`, not false success;
- [ ] provider failure with no deterministic fallback becomes retry/failure, not empty success;
- [ ] LLM Cold consolidation preserves negation/history/provenance, with deterministic fallback tested.

Required maintained regression examples include:

```text
我叫 TMs
我爱吃西瓜，我有个朋友卢鹏程也是
他说苹果也很好吃但是我不爱吃
Sway家在前滩
乔哲家也是
他俩住隔壁
```

## 5. Security gate

- [ ] secrets are checked before queue persistence/extractor egress, durable record write, embedding egress, Cold publication, recall, and prompt injection;
- [ ] rejected/transformed secret bodies do not appear in jobs, events, errors, audit receipts, vectors, or Cold files;
- [ ] scope isolation tests pass for records, topics, vectors, graph, export, and forget;
- [ ] stored prompt injection is quarantined/not injected;
- [ ] recalled memory is marked `data_not_instruction`;
- [ ] no `.env`, database, Cold data, log, screenshot, or credential is tracked by Git;
- [ ] public configuration endpoint exposes no memory credentials.

## 6. API, tools, and Web gate

- [ ] status, capture, jobs, recall, topic-get, records, export, and forget endpoints return expected JSON;
- [ ] Memory Center opens without HTTP 500 and renders real records/jobs/topics;
- [ ] disabled mode hides Memory Center;
- [ ] `memory_search`, `memory_topic_get`, and guarded `memory_forget` work from the Agent;
- [ ] UI labels distinguish queued, completed, completed-empty, and failed capture;
- [ ] a natural-language “记住了” is not used as the acceptance signal; persisted count/job state is inspectable.

## 7. Automated verification

Run from a clean install/worktree:

```bash
npm ci
npm run lint
npm run check
npm test
TAGENT_TEST_POSTGRES_URL=postgresql://... npm test -- tests/postgres-memory.test.ts
npm run build
git diff --check
npm audit --omit=dev --audit-level=high
```

If live quality tests are part of the release gate, provide only through CI secrets:

```text
TAGENT_TEST_LLM_BASE_URL
TAGENT_TEST_LLM_API_KEY
TAGENT_TEST_LLM_MODEL
```

Record exact test counts, PostgreSQL/pgvector versions, provider/model identifiers (not keys), and the release commit.

## 8. Deployment smoke test

- [ ] start the built server, not `tsx` development mode;
- [ ] confirm `/api/health` and `/api/config/status`;
- [ ] submit one explicit profile memory and observe `persistedCount > 0`;
- [ ] recall it in a new turn/session scope as designed;
- [ ] inspect it in Memory Center;
- [ ] publish/read one Cold Topic;
- [ ] restart and repeat recall;
- [ ] verify logs contain no credentials or raw rejected secrets.

## 9. Release decision

The feature is ready to merge/tag only when required checks above pass or every exception is documented as a release limitation with an owner and follow-up issue. Do not describe S3, multi-service workers, authenticated multi-tenancy, or complete retention/tombstone governance as release-complete unless separately tested and gated.
