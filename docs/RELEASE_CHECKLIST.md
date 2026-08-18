# Release checklist

This repository publishes a GitHub source/binary release, not an npm-registry release. Every workspace remains private and no workflow runs `npm publish`; the ABI and Core Client are attached as installable `.tgz` SDK assets.

Do not prefill this checklist or infer a pass from a previous release. Record the commit, command output, artifact checksums, current-schema validation, and Gateway probe for the candidate being tagged.

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
- [ ] No generated `*.tsbuildinfo`, database, WAL/SHM, secret, log, release archive, or local `runtime/activation.json` Host state is tracked.
- [ ] Architecture tests confirm the 13-workspace DAG, package exports, API-only Core, and Web dependency boundary.
- [ ] `pi-coding-agent` is absent from source, manifests, lockfile, release archive and `npm ls`; production `pi-agent-core`/`pi-ai` imports exist only in `adapters/runtime-pi`.
- [ ] `.agents` decision records pass `npm run check:agents`, have one owner per non-trivial decision, and match the shipped paths and verification commands.
- [ ] Maintained documentation passes `npm run check:docs`; every `docs/*.md` contract is indexed exactly once and all maintained local links resolve.
- [ ] AgentHarness runtime contracts cover quiescent asynchronous teardown, required cancellation ownership, transcript-invisible retry/fallback, provider `Retry-After`, steering/follow-up during retry and compaction, abort queue audit, structured tool failures, current-turn context preservation, provider idle timeout, threshold compaction and context-overflow recovery.
- [ ] Scripted wire-fault tests cover reset-before-headers, partial reset, missing `[DONE]`, malformed SSE, empty completion, rate-limit windows, request identity, and failed-partial isolation; fixed-seed state-machine properties remain reproducible.
- [ ] `npm run benchmark:compaction` reports full exact-fact literal recall within its checked bounded-cost threshold; its synthetic-corpus limitations remain documented.
- [ ] API tests confirm unversioned paths return 404.
- [ ] Core-managed Skill tests prove shared catalog CRUD, immutable revisions, multi-Skill Workspace references, TaskRun snapshot isolation, native `resources.skills`/`AgentHarness.skill()` invocation, and upload rejection for traversal, symlink, malformed ZIP, size, and tampering cases.

## PostgreSQL Memory gate

Run against PostgreSQL 17 with `vector` and `pg_trgm`:

```bash
TAGENT_TEST_POSTGRES_URL=postgresql://tagent_test:tagent_test@127.0.0.1:5432/tagent_memory_test \
  npx vitest run tests/postgres-memory.test.ts
```

- [ ] The persistent Memory profile passes.
- [ ] An absent PostgreSQL `memory` schema initializes as `tagent-memory/0.8`, version `1`, reopens successfully, and an unmarked/different schema is rejected.
- [ ] Memory-disabled startup does not connect to PostgreSQL/Cold storage or start Memory workers.
- [ ] Reindex vector writes atomically require the current unexpired lease and fencing token; a reclaimed worker cannot overwrite the newer worker's generation.
- [ ] Backup/restore and reindex generation behavior were rehearsed for production configuration changes.

## Current schema and recovery gate

- [ ] An empty database creates the complete current schema in one transaction and reopens successfully.
- [ ] `core_schema.schema_id` is `tagent-core/0.8`, `Store.getSchemaVersion()` and `PRAGMA user_version` are `2`, the migration journal/checksums are exact and append-only, and `sqlite_master` drift validation fails closed.
- [ ] The Core manifest declares `tagent-core/state-0.8-r2`; an r1 manifest is rejected after migration, and the pre-upgrade SQLite/WAL/SHM recovery set has been tested.
- [ ] A nonempty unmarked database, another schema ID, and missing/extra/changed schema objects are rejected with instructions to recreate the database.
- [ ] A second Core process is rejected by the OS lock/writer authority.
- [ ] The stable Host imports no application composition or persistence, supervises one Generation, rejects malformed/stale/incompatible IPC and release paths, and uses its own trusted verifier for candidates.
- [ ] Same-release restart, staged-release activation, drain timeout, candidate readiness/stabilization/heartbeat failure, activation replay/conflict, Host crash points, `current` rollback, parent disconnect, and durable crash-budget exhaustion pass.
- [ ] `core_generation_activate` is absent outside a managed immutable release, requires explicit external-action approval, dispatches only after its exact operation receipt is durable, and startup redispatch does not repeat a settled receipt.
- [ ] Writer lease/fence loss clears health readiness and closes Core.
- [ ] Restart recovery produces `outcome_unknown` for effects/deliveries whose outcome cannot be proven and `restart_before_effect` cancellation only before effect start.
- [ ] Automatic crash Continuations are queued only with no ambiguous effect, running tool, pending input/approval, or existing Continuation, and stop after the bounded recovery budget.
- [ ] An interrupted TaskRun command or Goal operation becomes `outcome_unknown`; a Session and its create receipt remain atomic across restart.
- [ ] A required passed check rejects self-reported, failed, stale, wrong-Run and wrong-Attempt evidence, and accepts only the matching successful Bash receipt.
- [ ] TaskRun completion Gate profiles are frozen at Admission: `off` skips completion review, `relaxed` performs at most one outcome-focused semantic review without plan/check prerequisites, and `strict` retains the full deterministic and semantic audit.
- [ ] TaskRuns without an explicit Gate profile remain `strict`; Web defaults new Workspace selections to `relaxed`; Submission idempotency conflicts when the same key is reused with a different profile.
- [ ] Semantic delivery uses the compact judge; substantial strict settlement sends actual bounded receipts to one full Supervisor call; relaxed settlement uses one bounded outcome review; deterministic failures, exact delivery, and disabled Gate skip unnecessary calls; malformed output does not trigger a schema-repair call.
- [ ] External-action approval, Workspace Goal authority, and mutation-capable tool policy remain enforced identically under `off`, `relaxed`, and `strict`.
- [ ] Same-release SQLite/WAL/SHM restore was tested in isolation; earlier schema IDs are rejected rather than upgraded.

## API, Web, and Gateway gate

- [ ] [Gateway handoff status](GATEWAY_HANDOFF_STATUS.md) confirms every dependency is either Core Ready, explicitly Gateway-owned, or deferred by current policy; a passing Core runtime probe alone cannot prove Gateway-owned behavior.
- [ ] `GET /api/v1/health` reports writer readiness and Host-managed Generation/activation/crash-budget status; `/api/health` returns 404.
- [ ] `GET /api/v1/capabilities` matches the release/schema, required commands/events, base Operator endpoint list, ready Approval contract, receipt-recovery protocol, retention and limits; `operator.read.v1` and `/api/v1/operator/capabilities` match the independent read profile.
- [ ] Credential mode fails closed for missing, invalid, and under-scoped opaque tokens.
- [ ] Resource scopes are enforced from server configuration.
- [ ] Exact CORS origins pass and wildcard/invalid origins fail startup or request policy as designed.
- [ ] The Gateway validates OIDC claims and translates to a minimal Core credential; Core is private.
- [ ] Session create, Submission, command and Goal operation identities replay the original result and conflict on changed canonical payload.
- [ ] Command receipt lookup precedes Attempt fencing; structured failures survive replay; unprovable effects are not repeated.
- [ ] Event-consumer replay persists before ACK, reclaims a new generation, reaches zero lag, and settled/final events are acknowledged with the correct boundary.
- [ ] Transcript, interaction and Artifact metadata pages enforce default/max limits; SSE batch/buffer bounds and HTTP 413 Artifact limits match capabilities.
- [ ] Operator Session/TaskRun lists enforce scope/default/max limits, tied-key and snapshot pagination, cursor retry/mismatch/restart behavior, empty/latest semantics and public-summary redaction.
- [ ] Core-owned ABI fixtures and provider/consumer tests pass. Gateway separately proves its Fake Core against the exact current Core/SDK tuple before production cutover.
- [ ] `GET /api/v1/capability-profiles` returns all five profile `1.0` summaries/details for the production principal, with the expected 27 unique endpoint IDs/routes, fine-grained scopes, pagination/retention and exact-replay/durable-receipt recovery semantics.
- [ ] Profile exact replay precedes mutable validation/live/Router/filesystem work and returns the stored projection/ETag after later changes; Memory snapshot traversal reaches every member in a 501-row collection.
- [ ] The real provider harness and canonical fixture suite pass; no Fake Core or Gateway transport simulation has been moved into Core.
- [ ] `scripts/gateway-readiness-probe.mjs` exits 0 with `ready=true` and no reasons.
- [ ] Web is served from its independent artifact and targets the Gateway/Core origin; Core serves no static Web content.
- [ ] The Web style gate confirms the canonical four-file entrypoint, named cascade ownership, semantic light/dark colors, shared visual scales, boot-theme parity, live selectors, and no shadowed declarations.
- [ ] Workspace sidebar/switcher, composer and live Run surfaces, Skills, keyboard shortcuts, Workspace Goals, and Memory were rendered in desktop light/dark and 390px mobile light/dark with no horizontal overflow.
- [ ] Web Skills center upload/drag-and-drop, edit/delete, multi-select Workspace references, empty/loading/error states, keyboard focus, light/dark theme, and mobile-width states were rendered and checked.
- [ ] The Gate selector is visible above the composer, retains its per-Workspace setting, and renders correctly in light/dark themes and mobile widths; Run detail explains the frozen profile.

## Artifact gate

On Linux x64 with the exact toolchain:

```bash
npm run release:build
```

- [ ] Core and Web Console tarballs, ABI and Core Client `.tgz` files, and all four SHA-256 files exist.
- [ ] Each `.sha256` records only the artifact basename and verifies after the artifact/checksum pair is downloaded into an arbitrary directory.
- [ ] Both release manifests verify from unpacked archives.
- [ ] Core contains materialized required workspaces, no symbolic links, no Web assets, and a working native SQLite binding.
- [ ] Core exposes only syntax-valid `dist/host.js` as its system entrypoint, contains the syntax-valid private Host module and `node_modules/@tagent/core-service/dist/generation-entry.js` child, and records the exact Host/state/generation-entry manifest contract; deployment stages an existing installation without changing `current`, restarting systemd, or probing health.
- [ ] Web contains `dist/index.html`, its manifest, no Core runtime, and the expected build-time origin policy.
- [ ] Both SDK tarballs have version parity with Core, contain JS, declarations, JS source maps and declaration maps, exclude build caches, and pass isolated joint install/runtime/type smoke tests.
- [ ] An isolated Core artifact starts and passes `/api/v1/health`.

## Publish

- [ ] `main` is clean, pushed, and the candidate commit equals `origin/main`.
- [ ] Create and push the annotated `vVERSION` tag.
- [ ] The tag-triggered release workflow checks out the tag, installs npm 12, runs PostgreSQL and repository gates, verifies tag/version equality, and builds all four release artifacts.
- [ ] The workflow uploads all four artifacts and checksums as one 30-day Actions artifact.
- [ ] The workflow creates the GitHub Release with non-empty changelog notes, verifies the tag, and attaches all eight files.
- [ ] Downloaded release assets match their attached checksums and manifests.

Release only when every required gate passes or the release is explicitly stopped. Do not publish a stable tag with an undocumented exception.
