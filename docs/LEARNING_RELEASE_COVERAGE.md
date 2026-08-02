# v0.1.8 Learning release acceptance coverage

This document maps the Memory/Learning release contract to stable, reviewable implementation and test evidence.

## AC-1 — Memory-off disables all Learning paths

Primary automated evidence: `tests/learning-release-coverage.test.ts`, test **Memory-off disables every Learning API family, projector, scheduler, distiller, evolution and active path**.

The test verifies, in one state transition:

- persisted state normalizes to Memory=false, Learning=false, automatic execution=false and passive Learning=false;
- Distillation Worker reports `running=false` and `ready=false`;
- run projection produces no Experience Observation;
- Distillation scheduling/claiming returns no job;
- Workflow recall returns no prompt or Context Manifest item;
- explicit teaching and approval creation throw the Memory dependency error;
- Learning Center, Learning Events, Communication Profiles/preferences, Corrections, Run Learning Policy, Distillation run/dead-letter, activation, promotion, feedback attribution and autonomy execution APIs all return HTTP 503 with `code=learning_disabled`;
- no approval request or observation is persisted.

The route-family gate is implemented by `isLearningRoute()` plus the Fastify `preHandler` in `src/app.ts`; service/worker defense-in-depth is implemented in `LearningFeatureControl`, `WorkflowService`, `AgentService` and `DistillationWorker`.

## AC-3 — Web top-bar switch content

Primary automated evidence: `tests/learning-release-coverage.test.ts`, test **top-bar UI source exposes state, Memory dependency and permanent approval warning**.

It checks `web/src/App.tsx` for:

- `Learning execution`;
- `Memory required`;
- `Off · passive learning only`;
- `On · approval always required`;
- `Every active action still requires human approval.`;
- a semantic `role="switch"`, `aria-checked`, and a disabled condition when Learning is unavailable.

The production-build check additionally compiles this component and its `.learning-execution-control` styles into `dist/web`.

## AC-4 — Passive abilities allowed, active abilities denied

Primary automated evidence: `tests/learning-release-coverage.test.ts`, test **passive mode allows observation, evidence, distillation and candidate evolution but blocks all active operation families**.

It proves that automatic execution=false still allows:

- two verified run outcome observations;
- Learning audit entries for observe and learn;
- durable Distillation Job processing;
- a distilled Workflow candidate that remains inactive;
- evolution/distillation audit evidence.

In the same mode it proves:

- runtime Workflow recall injects nothing;
- Workflow activation request is rejected;
- Revision proposal application request is rejected;
- Canary promotion request is rejected;
- generic Workflow execution approval creation is rejected;
- zero autonomy approval requests are persisted.

`WorkflowService.requireAutoExecution()` now runs before object lookup/governance checks on all active families, including activation, application records, Revision application, Canary promotion and generic execution approval.

## AC-8 — Documentation topic coverage

Primary automated evidence: `tests/learning-release-coverage.test.ts`, test **release documentation covers every required operational topic with concrete state and approval contracts**.

It checks `docs/LEARNING.md` for these required sections:

- release boundary;
- hard Memory dependency;
- mode table and passive/active definitions;
- configuration;
- API;
- Web UI;
- state transitions;
- upgrade and migration;
- operations;
- troubleshooting;
- rollback and emergency disable.

It also checks for the exact dependency invariant, passive observation, Experience Observation, durable Distillation Jobs, Workflow candidates, the request/approve/execute state machine, `activeExecutionRequiresApproval`, 503/409 behavior, Schema v22, database backup and emergency passive-only mode.

## Verification command

```sh
npx vitest run \
  tests/learning-release-coverage.test.ts \
  tests/learning-feature-control.test.ts \
  tests/workflow-autonomy.test.ts \
  tests/workflow-learning.test.ts
```

Expected result for the focused release gate: 4 files and 21 tests passed.
