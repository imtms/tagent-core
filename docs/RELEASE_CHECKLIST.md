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
npm run benchmark:compaction
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
npm audit --audit-level=high --registry=https://registry.npmjs.org
git diff --check
```

- [ ] All commands exit 0.
- [ ] No generated `*.tsbuildinfo`, database, WAL/SHM, secret, log, or release archive is tracked.
- [ ] Architecture tests confirm the 13-workspace DAG, package exports, API-only Core, and Web dependency boundary.
- [ ] `pi-coding-agent` is absent from source, manifests, lockfile, release archive and `npm ls`; production `pi-agent-core`/`pi-ai` imports exist only in `adapters/runtime-pi`.
- [ ] `.agents` decision records pass `npm run check:agents`, have one owner per non-trivial decision, and match the shipped paths and verification commands.
- [ ] AgentHarness runtime contracts cover quiescent asynchronous teardown, required cancellation ownership, transcript-invisible retry/fallback, steering/follow-up during retry and compaction, abort queue audit, structured tool failures, current-turn context preservation, provider idle timeout, threshold compaction and context-overflow recovery.
- [ ] Scripted wire-fault tests cover reset-before-headers, partial reset, missing `[DONE]`, malformed SSE, empty completion, request identity, and failed-partial isolation; fixed-seed state-machine properties remain reproducible.
- [ ] `npm run benchmark:compaction` reports full exact-fact literal recall within its checked bounded-cost threshold; its synthetic-corpus limitations remain documented.
- [ ] Differential API tests confirm removed unversioned routes return 404.
- [ ] Core-managed Skill tests prove shared catalog CRUD, immutable revisions, multi-Skill Workspace references, TaskRun snapshot isolation, native `resources.skills`/`AgentHarness.skill()` invocation, and upload rejection for traversal, symlink, malformed ZIP, size, and tampering cases.

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
- [ ] The candidate migrated v30 → v31 → v32 → v33 → v34 → v35 → v36 → v37 → v38 → v39 → v40 → v41 → v42 → v43 → v44 → v45 → v46 and reopened idempotently.
- [ ] `schema_meta.version` is 46; trusted-evidence and Goal-execution drift checks pass; complete v39 receipt/ACK shapes, the v40 Submission audit shape, exact v41 Operator Read indexes, the v42 Inbox execution-policy column, the v43 Skill catalog, the v44 Workspace reference table/index/constraints, the v45 exact request-envelope table/index/composite foreign key, and the v46 continuation due-time column/index pass fail-closed validation; `migration_issues` has zero open rows.
- [ ] A second Core process is rejected by the OS lock/writer authority.
- [ ] Writer lease/fence loss clears health readiness and closes Core.
- [ ] Restart recovery produces `outcome_unknown` for effects/deliveries whose outcome cannot be proven and `restart_before_effect` cancellation only before effect start.
- [ ] An interrupted TaskRun command or Goal operation becomes `outcome_unknown`; a Session and its create receipt remain atomic across restart.
- [ ] A required passed check rejects self-reported, failed, stale, wrong-Run and wrong-Attempt evidence, and accepts only the matching successful Bash receipt.
- [ ] TaskRun completion Gate profiles are frozen at Admission: `off` skips completion review, `relaxed` performs at most one outcome-focused semantic review without plan/check prerequisites, and `strict` retains the full deterministic and semantic audit.
- [ ] Older clients and persisted TaskRuns without a profile remain `strict`; Web defaults new Workspace selections to `relaxed`; Submission idempotency conflicts when the same key is reused with a different profile.
- [ ] Semantic delivery uses the compact judge; substantial strict settlement sends actual bounded receipts to one full Supervisor call; relaxed settlement uses one bounded outcome review; deterministic failures, exact delivery, and disabled Gate skip unnecessary calls; malformed output does not trigger a schema-repair call.
- [ ] External-action approval, Workspace Goal authority, and mutation-capable tool policy remain enforced identically under `off`, `relaxed`, and `strict`.
- [ ] Restoring the pre-upgrade backup with the old artifact was tested as the 0.1.x rollback path.

## API, Web, and Gateway gate

- [ ] [Gateway handoff status](GATEWAY_HANDOFF_STATUS.md) confirms every dependency is either Core Ready, explicitly Gateway-owned, or deferred by current policy; a passing Core runtime probe alone cannot prove Gateway-owned behavior.
- [ ] `GET /api/v1/health` reports writer readiness; `/api/health` returns 404.
- [ ] `GET /api/v1/capabilities` matches the release/schema, required commands/events, legacy Operator allowlist, active Approval authority, receipt-recovery protocol, retention and limits; `operator.read.v1` and `/api/v1/operator/capabilities` match the independent read profile.
- [ ] Credential mode fails closed for missing, invalid, and under-scoped opaque tokens.
- [ ] Resource scopes are enforced from server configuration.
- [ ] Exact CORS origins pass and wildcard/invalid origins fail startup or request policy as designed.
- [ ] The Gateway validates OIDC claims and translates to a minimal Core credential; Core is private.
- [ ] Session create, Submission, command and Goal operation identities replay the original result and conflict on changed canonical payload.
- [ ] Command receipt lookup precedes Attempt fencing; structured failures survive replay; unprovable effects are not repeated.
- [ ] Event-consumer replay persists before ACK, reclaims a new generation, reaches zero lag, and settled/final events are acknowledged with the correct boundary.
- [ ] Transcript, interaction and Artifact metadata pages enforce default/max limits; SSE batch/buffer bounds and HTTP 413 Artifact limits match capabilities.
- [ ] Operator Session/TaskRun lists enforce scope/default/max limits, tied-key and snapshot pagination, cursor retry/mismatch/restart behavior, empty/latest semantics and public-summary redaction.
- [ ] Core-owned ABI fixtures and provider/consumer tests pass. Gateway separately proves its fake Core and current/previous-client matrix before its production cutover.
- [ ] `scripts/gateway-readiness-probe.mjs` exits 0 with `ready=true` and no reasons.
- [ ] Web is served from its independent artifact and targets the Gateway/Core origin; Core serves no static Web content.
- [ ] Web Skills center upload/drag-and-drop, edit/delete, multi-select Workspace references, empty/loading/error states, keyboard focus, light/dark theme, and mobile-width states were rendered and checked.
- [ ] The Gate selector is visible above the composer, retains its per-Workspace setting, and renders correctly in light/dark themes and mobile widths; Run detail explains the frozen profile.

## Artifact gate

On Linux x64 with the exact toolchain:

```bash
npm run release:build
```

- [ ] Core and Web Console tarballs and both SHA-256 files exist.
- [ ] Each `.sha256` records only the archive basename and verifies after both files are downloaded into an arbitrary directory.
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
