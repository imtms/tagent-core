# TAgent Core 0.1.0 Release Audit

Date: 2026-08-01 (Asia/Singapore)

## Decision

TAgent Core meets the code, test, documentation, dependency, and deployment gates for a `0.1.0` stable source release within the documented trusted single-service profile.

This decision does not certify direct public-Internet, hostile multi-tenant, or operating-system-sandboxed operation.

## Audited scope

- SQLite control plane, TaskRun supervision, Pi runtime, tools, Fastify/SSE API, and React Web application;
- optional PostgreSQL/pgvector/pg_trgm plus Local Cold memory profile;
- release build and deployment scripts, configuration, security guidance, dependencies, README, license, and changelog;
- the live systemd instance on port 3220.

## Findings resolved

1. **Cold revision churn:** semantic consolidation could publish a new immutable revision on every maintenance interval even when no Warm record changed. The live database showed 143 revisions for one unchanged procedure topic. Consolidation now skips generation when all eligible records are older than the current published revision, with regression coverage.
2. **Background worker rejection visibility:** interval callbacks launched promises without terminal handlers. Capture and maintenance ticks now catch and log failures.
3. **Shutdown race:** memory shutdown cleared timers and immediately closed PostgreSQL while active maintenance could still be using the pool. Worker shutdown is now async and waits for active tasks before closing adapters.
4. **Release metadata drift:** version, README, security language, package metadata, license, notice, changelog, and release workflow were aligned for `0.1.0`. Authorship states that TAgent Core was designed by TMs and developed with AI assistance.

## Release evidence

The release commit must pass:

```text
npm ci
npm run lint
npm run check
npm test -- --run
TAGENT_TEST_POSTGRES_URL=... npm test -- --run tests/postgres-memory.test.ts
npm run build
npm audit --omit=dev --audit-level=high
npm audit --audit-level=high
git diff --check
```

It must also pass built-server smoke tests on port 3220, including health, runtime status, sessions, memory status/export/recall, graceful restart, and verification that the running checkout matches `origin/main`.

## Accepted limitations

- one trusted process and one trusted workspace;
- SQLite is not a multi-process contract;
- Web and administrative routes need a private network or authenticated reverse proxy;
- scoped service credentials cover automation clients, not browser login or complete tenancy;
- `bash` is not OS-sandboxed;
- Local Cold is the release-gated object store; S3 and independent workers are optional profiles;
- semantic extraction and embedding quality depends on configured external providers.

These limitations are explicit in README and SECURITY and do not block the scoped `0.1.0` release.
