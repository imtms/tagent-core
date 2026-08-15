# TaskRun delivery and finalization workflow

Use this workflow for every substantial development TaskRun using the `strict` Gate profile. `relaxed` open-ended work does not require this plan/check ceremony, and `off` skips completion acceptance entirely. Safety approvals and tool policies remain mandatory in every profile.

## Invariants

1. Read the durable TaskRun before planning or changing files.
2. Update existing plan keys. Do not create a semantically equivalent replacement for an existing required item.
3. Treat branch checks and deployment preflight as safety gates, not automatically as final completion evidence.
4. Complete every operation that can change delivery state before registering final required checks.
5. A final required check must be bound to a successful Bash receipt from the current Attempt.
6. After final checks are registered, do not run Bash, mutate files, add plans, change Git state, deploy, restart services, or otherwise change delivery state.
7. Submit the final candidate only after every required plan is terminal, every required check is passed and fresh, and `completionGate.failures` is empty.

## Standard sequence

### 1. Discover

1. Call `task_run get`.
2. Inspect the contract, phase, existing plan, checks, artifacts, pending input, continuations, and completion-gate failures.
3. Inspect the workspace and deployment state without changing them.
4. Reuse existing plan keys. Add an item only for work not already represented.

### 2. Plan

Keep the plan small and non-overlapping. For an existing required item, update its status rather than introducing an alias. If replanning is necessary, close the superseded item as `done`, `skipped`, or `blocked` in the same batch that introduces its replacement.

A required plan item must never be abandoned as `pending` or `in_progress` merely because later work covered the same meaning under another key.

### 3. Implement and pre-verify

1. Read unfamiliar files before editing them.
2. Implement the focused change and its regression coverage.
3. Run targeted checks, then repository checks.
4. Resolve failures by inspecting retained output and materially changing the approach; never repeat an identical failed Bash command unchanged.

These checks prove that the candidate is safe to deliver. They can become stale after a later commit, merge, artifact build, or deployment and therefore are not necessarily the final TaskRun evidence.

### 4. Deliver

Complete every applicable delivery action before finalization:

1. commit with the repository's required message language;
2. push the topic branch;
3. create or update the MR/PR;
4. wait for required CI;
5. merge without bypassing failed required checks;
6. delete the short-lived branch when appropriate;
7. back up persistent data;
8. build and verify immutable artifacts;
9. rehearse deployment recovery where required;
10. deploy or switch the release;
11. restart or reload services;
12. execute production health, readiness, metrics, API, database, and recovery checks.

If an item is not applicable, record that fact in the delivery report; do not invent an external action.

### 5. Audit required plans

After delivery and production operations, read the TaskRun again and inspect every original required plan key.

- Mark completed work `done`.
- Mark legitimately unnecessary work `skipped` with a reason.
- Leave an item `blocked` only when a real external dependency prevents completion.
- Do not add a replacement item to hide an old `pending` or `in_progress` item.

Perform plan-state convergence before the final verification commands.

### 6. Run final verification

Run the smallest complete verification set against the actual delivered state. It should normally cover:

- final source quality and tests on the merged commit;
- final Git/MR/CI and artifact identity;
- deployed release, service, and production smoke state when deployment is in scope.

Prefer a small set of orthogonal evidence commands. Avoid redundant required checks such as one aggregate `quality` check plus separate required `lint`, `typecheck`, `build`, and `tests` checks for the same receipt set.

### 7. Register final required checks

Only now register the minimal required checks, for example:

```text
final-quality
final-delivery
production-smoke
```

Each passed check must reference its exact successful Bash command or successful operation ID from the current Attempt. Batch independent check and plan mutations when possible.

### 8. Final gate audit

Call `task_run get` and verify all of the following:

```text
all required plans are done or skipped
all required checks are passed
all required checks have stale=false
completionGate.failures is empty
no user input is pending
no queued or running continuation can duplicate delivery
```

If a check is stale or failed, return to final verification, produce fresh evidence, and register it again. If a plan is not terminal, update that original key. Do not submit the candidate while any deterministic gate is failing.

### 9. Freeze and report

After the final gate audit:

- do not call Bash;
- do not mutate the workspace;
- do not change Git, MR, CI, artifact, database, deployment, or service state;
- do not create or rename plan items;
- do not register additional checks unless the gate explicitly requires repair.

Submit one complete standalone report containing the delivered result, verification commands and actual results, external delivery/deployment state, recovery or backup information where applicable, and any real failures or deferred items.

## Recovery from a blocked TaskRun

Before doing any work, inspect the original TaskRun and already completed external side effects.

- For stale evidence: do not repeat implementation, MR, merge, or deployment. Re-run only the final verification needed for the actual delivered state and refresh the stale check.
- For an unfinished required plan: update the original plan key; do not create a semantic duplicate.
- For a stream interruption: resume from durable state and deliver a complete replacement candidate without repeating side effects.
- For a real external dependency: request only the missing typed user input and pause.

## Quick finalization checklist

```text
[ ] Current TaskRun was read before planning
[ ] Existing plan keys were reused
[ ] Code and development verification completed
[ ] Git, MR/PR, CI, and merge completed where applicable
[ ] Backup, artifact, deployment, and production operations completed where applicable
[ ] Every original required plan is done/skipped
[ ] Final verification ran after every delivery-changing operation
[ ] Minimal required checks are passed and stale=false
[ ] completionGate.failures is empty
[ ] No Bash or state mutation occurs after final check registration
[ ] Final report is complete and standalone
```
