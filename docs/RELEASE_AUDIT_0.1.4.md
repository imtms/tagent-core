# TAgent Core 0.1.4 Release Audit

Date: 2026-08-01 (Asia/Singapore)  
Target tag: `v0.1.4`  
Baseline reviewed: `v0.1.0..main`

## Decision

`0.1.4` is a patch release candidate for the documented trusted single-service `0.1.x` profile. It does not expand the security boundary to public multi-tenant hosting. Tagging is allowed only after the exact release commit passes the repository CI, PostgreSQL memory integration, dependency audits, production build, and deployment smoke tests.

## Changes reviewed since 0.1.0

### 0.1.1 changes (shipped in tagged 0.1.2)

- memory provenance classes and trust metadata;
- assistant-prose exclusion and role-aware context-prune capture;
- combined hard memory prompt budget;
- capture lease heartbeat, fencing, and compare-and-set completion;
- required PostgreSQL 17/pgvector/pg_trgm CI.

No `v0.1.1` tag was published; the internal version increment was superseded by `v0.1.2`.

### 0.1.2

- stable mobile viewport and contained scrolling;
- compact collapsed tool activity;
- separated assistant response cards;
- responsive composer and safe-area behavior.

### 0.1.3

- safe `markdown-it` rendering and bounded syntax highlighting;
- optimistic user-message visibility and persisted-message reconciliation;
- active-run polling/SSE recovery and workspace-switch request fencing;
- newest-200 message window in chronological display order;
- idempotent Web Run controls.

### 0.1.4

- reject control-plane logs, TaskRun/Artifact wrappers, file metadata, malformed Chinese negation, one-off questions, and operational requests from semantic memory;
- disable automatic TaskRun outcome capture and retain operational evidence only in the control plane;
- canonical organization topics and semantic fingerprints;
- domain-routed recall with minimum thresholds, zero-result behavior, identity isolation, deduplication, contradiction suppression, and organization path pruning;
- reversible dirty-memory quarantine scripts and audit snapshots;
- reject opaque browser/E2E markers before Message or TaskRun creation;
- enforce hard token ceilings during execution while treating complexity-tier amounts as soft convergence checkpoints;
- increase the default cumulative hard token ceiling to 8,000,000 while retaining continuation and wall-clock bounds.

## Compatibility

- Memory remains opt-in and disabled by default.
- Existing SQLite control-plane databases migrate forward through additive application migrations.
- PostgreSQL memory migration is additive/idempotent for the supported profile.
- Existing dirty semantic records are not silently deleted; operators must dry-run, back up, and explicitly apply the quarantine scripts.
- The production artifact target remains Linux x64, Node.js 24.18.1 / ABI 137.

## Required release evidence

Evidence recorded during release preparation:

- [x] `npm ci` on Node.js 24.18.1 / npm 12.0.2
- [x] `npm run lint`
- [x] `npm run check`
- [x] `npm test -- --run`: 230 passed, 3 optional external tests skipped
- [x] PostgreSQL 17.10 with `vector` and `pg_trgm`: 2/2 integration tests passed in an isolated test database
- [x] `npm run build`: 1,783 Web modules transformed
- [x] production and full high-severity dependency audits: 0 vulnerabilities
- [x] `git diff --check`
- [x] memory-disabled built-server smoke: health/config HTTP 200, `memoryEnabled=false`, memory API HTTP 503, default hard limit 8,000,000
- [x] PostgreSQL + Local Cold live profile was active during audit; existing release regressions cover persistence, publication, recall, and restart-safe stores
- [x] Markdown/mobile/chat regressions are included in the 230-test suite; manual browser recheck remains a deployment smoke item before public announcement
- [x] opaque-marker admission: HTTP 422 with zero Message and zero TaskRun persistence
- [x] immutable Linux x64 Node 24 / ABI 137 archive built and manifest/native-module verified
- [ ] clean worktree, version consistency, and `main == origin/main` (complete after the release-preparation commit is pushed)

## Supported boundary and known limitations

Supported:

- one trusted process and workspace;
- SQLite control plane;
- localhost/private network deployment;
- optional PostgreSQL 17 + pgvector + pg_trgm memory with Local Cold;
- OpenAI-compatible runtime, embedding, and optional extractor providers.

Not release-gated as production-complete:

- direct public-Internet exposure;
- built-in browser login, CSRF protection, or complete multi-tenant membership;
- OS-level Bash sandboxing;
- multiple processes sharing SQLite;
- S3 Cold as the primary tested profile;
- independent memory worker clusters;
- incremental/checkpointed embedding reindex;
- complete tombstone/retention/approval governance;
- full per-channel recall scoring trace and offline recall metrics.

## Publication procedure

After all required evidence passes on the release commit:

```bash
git tag -a v0.1.4 -m "TAgent Core 0.1.4"
git push origin main v0.1.4
```

The tag-triggered workflows must create the stable GitHub Release and immutable Linux x64 production artifact. Do not create the tag from a different commit than the audited `main` head.
