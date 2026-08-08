# Release checklist

This repository publishes a GitHub source/binary release, not npm packages. Every workspace is private and no workflow runs `npm publish`.

Do not prefill this checklist or infer a pass from a previous release. Record the commit, command output, artifact checksums, migration rehearsal, and Gateway probe for the candidate being tagged.

## Toolchain

- [ ] Candidate version is identical in the root and all 13 workspace manifests.
- [ ] Every internal `@tagent/*` dependency pin and `package-lock.json` uses that version.
- [ ] Node.js is exactly `24.18.1`.
- [ ] npm major is 12 or newer.
- [ ] Linux x64/Node ABI 137 is used for production artifacts.
- [ ] `CHANGELOG.md` contains a non-empty `## [VERSION]` section.

## Source gates

Run from a clean checkout with the official npm registry:

```bash
npm ci --registry=https://registry.npmjs.org
npm run lint
npm run check
npm test -- --run
npm run build
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
npm audit --audit-level=high --registry=https://registry.npmjs.org
git diff --check
```

- [ ] All commands exit 0.
- [ ] No generated `*.tsbuildinfo`, database, WAL/SHM, secret, log, or release archive is tracked.
- [ ] Architecture tests confirm the 13-workspace DAG, package exports, API-only Core, and Web dependency boundary.
- [ ] Differential API tests confirm removed unversioned routes return 404.

## PostgreSQL Memory gate

Run against PostgreSQL 17 with `vector` and `pg_trgm`:

```bash
TAGENT_TEST_POSTGRES_URL=postgresql://tagent_test:tagent_test@127.0.0.1:5432/tagent_memory_test \
  npx vitest run tests/postgres-memory.test.ts
```

- [ ] The persistent Memory profile passes.
- [ ] Memory-disabled startup does not connect to PostgreSQL/Cold storage or start Memory/Learning workers.
- [ ] Backup/restore and reindex generation behavior were rehearsed for production configuration changes.

## Migration and recovery gate

- [ ] A representative 0.1.x database plus WAL/SHM was backed up and restored in isolation.
- [ ] The candidate migrated v30 → v31 → v32 → v33 → v34 → v35 → v36 → v37 → v38 and reopened idempotently.
- [ ] `schema_meta.version` is 38, trusted-evidence and Goal-execution columns/tables/indexes pass drift validation, and `migration_issues` has zero open rows.
- [ ] A second Core process is rejected by the OS lock/writer authority.
- [ ] Writer lease/fence loss clears health readiness and closes Core.
- [ ] Restart recovery produces `outcome_unknown` for effects/deliveries whose outcome cannot be proven and `restart_before_effect` cancellation only before effect start.
- [ ] A required passed check rejects self-reported, failed, stale, wrong-Run and wrong-Attempt evidence, and accepts only the matching successful Bash receipt.
- [ ] Substantial settlement sends actual bounded receipts to one semantic Supervisor call; deterministic failures skip it and malformed output does not trigger a schema-repair call.
- [ ] Restoring the pre-upgrade backup with the old artifact was tested as the 0.1.x rollback path.

## API, Web, and Gateway gate

- [ ] `GET /api/v1/health` reports writer readiness; `/api/health` returns 404.
- [ ] Credential mode fails closed for missing, invalid, and under-scoped opaque tokens.
- [ ] Resource scopes are enforced from server configuration.
- [ ] Exact CORS origins pass and wildcard/invalid origins fail startup or request policy as designed.
- [ ] The Gateway validates OIDC claims and translates to a minimal Core credential; Core is private.
- [ ] Event-consumer replay persists before ACK, reclaims a new generation, reaches zero lag, and terminal events are acknowledged.
- [ ] `scripts/gateway-readiness-probe.mjs` exits 0 with `ready=true` and no reasons.
- [ ] Web is served from its independent artifact and targets the Gateway/Core origin; Core serves no static Web content.

## Artifact gate

On Linux x64 with the exact toolchain:

```bash
npm run release:build
```

- [ ] Core and Web Console tarballs and both SHA-256 files exist.
- [ ] Both release manifests verify from unpacked archives.
- [ ] Core contains materialized required workspaces, no symbolic links, no Web assets, and a working native SQLite binding.
- [ ] Web contains `dist/index.html`, its manifest, no Core runtime, and the expected build-time origin policy.
- [ ] An isolated Core artifact starts and passes `/api/v1/health`.

## Publish

- [ ] `main` is clean, pushed, and the candidate commit equals `origin/main`.
- [ ] Create and push the annotated `vVERSION` tag.
- [ ] The tag-triggered release workflow checks out the tag, installs npm 12, runs PostgreSQL and repository gates, verifies tag/version equality, and builds both immutable artifacts.
- [ ] The workflow uploads both tarballs and checksums as one 30-day Actions artifact.
- [ ] The workflow creates the GitHub Release with non-empty changelog notes, verifies the tag, and attaches all four files.
- [ ] Downloaded release assets match their attached checksums and manifests.

Release only when every required gate passes or the release is explicitly stopped. Do not publish a stable tag with an undocumented exception.
