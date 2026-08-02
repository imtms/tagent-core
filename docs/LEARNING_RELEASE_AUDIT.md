# v0.1.9 Memory/Learning release audit

This audit is the compact, line-addressable evidence index for the v0.1.9 release and 3220 deployment.

## Feature enforcement

| Requirement | Implementation evidence | Automated evidence |
| --- | --- | --- |
| Memory hard-depends Learning | `src/learning/feature-control.ts:33-65` rejects invalid transitions and normalizes Memory off to Learning/auto off | `tests/learning-feature-control.test.ts:11-17`; `tests/learning-release-coverage.test.ts:35-74` |
| Worker stops with Learning | `src/server.ts:32-35` starts/stops Distillation Worker from effective Learning state | `tests/learning-feature-control.test.ts:32-42`; release coverage lines 40-46 |
| Learning API families disabled | `src/app.ts:43-49,508-509` applies `learning_disabled` to all Learning route families | release coverage lines 52-73 verifies 13 route families |
| Passive observation/learning/distillation/evolution | `src/learning/workflow-service.ts:107-180` records observations and queues durable distillation | release coverage lines 76-89 |
| Passive mode blocks active paths | `src/learning/workflow-service.ts:352-353,423-425,469-470,708-710,775-776` uses the auto-execution gate for approvals, execution, application, revision apply and canary | release coverage lines 90-95 |
| Human approval remains mandatory | `src/learning/workflow-service.ts:352-436,455-458` persists pending requests and executes only approved requests | `tests/workflow-autonomy.test.ts:21-47` |
| Top Web switch | `web/src/App.tsx:311,665` shows Memory dependency, passive state and approval warning with a semantic switch | release coverage lines 98-106 |
| Persistence | `src/learning/feature-control.ts:18-27,68-70` loads and saves singleton settings | `tests/learning-feature-control.test.ts:19-30`; 3220 SQLite/API evidence below |

## Documentation coverage

`docs/LEARNING.md` contains:

- release boundary and hard dependency: lines 3-19;
- passive/active modes and approval state machine: lines 21-46;
- configuration and API: lines 48-86;
- Web UI: lines 88-96;
- state transitions: lines 98-105;
- migration and rollback constraints: lines 107-111;
- operations and expected states: lines 113-141;
- troubleshooting: lines 143-149;
- emergency disable and rollback: lines 151-172.

Automated documentation evidence is `tests/learning-release-coverage.test.ts:108-116`.

## Test evidence

Focused command:

```sh
npx vitest run tests/learning-release-coverage.test.ts tests/learning-feature-control.test.ts tests/workflow-autonomy.test.ts tests/workflow-learning.test.ts --reporter=verbose
```

Observed result:

```text
Test Files 4 passed (4)
Tests 21 passed (21)
```

Breakdown: release coverage 4/4, feature control 3/3, autonomy 5/5, workflow learning 9/9.

Full suite: 34 files passed, 1 skipped; 356 tests passed, 3 skipped.

## Release and 3220 evidence

- Release: `v0.1.9`.
- Commit: `cff9562723c628dfedcdd85b59ba50ab3af84d7f`.
- Git relation: `HEAD = origin/main = v0.1.9`.
- Artifact: `/var/tmp/tagent-core-cff9562723c628dfedcdd85b59ba50ab3af84d7f-linux-x64-node24-abi137.tar.gz`.
- Artifact gzip, SHA-256 and release Manifest checks passed.
- systemd unit runs `/opt/tagent-core-memory-v019/current/dist/server.js`.
- Current process cwd resolves to `/opt/tagent-core-memory-v019/releases/cff9562723c628dfedcdd85b59ba50ab3af84d7f`.
- `RELEASE_COMMIT` contains the same commit.
- `/api/health`: `ok=true`, Memory ready, Distillation running/ready.
- `/api/config/status`: Schema 22, Learning requires Memory, active execution requires approval.
- `/api/learning/settings` and SQLite agree on Memory=true, Learning=true, autoExecution=false, passive=true and approvalRequired=true.
- Persisted reason after restart: `v0.1.9_release_final_passive_mode`.
- Upgrade backup: `/var/lib/tagent-core-memory/tagent.db.pre-v0.1.8.20260802223222.backup`, integrity check `ok`, pre-upgrade Schema 16.

## Live governance probes completed

- Memory off forced Learning and auto execution off and stopped the Worker.
- Restoring Memory+Learning restarted the Worker.
- Direct Workflow activation returned HTTP 409 without approval.
- Activation request became pending; human rejection left `executedAt=null`.
- In passive mode an active request returned HTTP 409.
- A final restart retained passive mode in both API and SQLite.
