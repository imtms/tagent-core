# Lightweight Workspace Goals

This release adds a deliberately small Workspace-level Goal shell on top of the existing TaskRun runtime.

## Scope

- durable Goal definition revisions and content hashes;
- human decisions for Goal approval, plan approval, pause/resume, close and cancel;
- optional Plan revisions, TaskRun links and evidence links;
- deterministic `nextAction` projection at read time;
- a first-party Goals panel for multi-criterion editing, definition revision, bounded plan authoring, partial plan approval, TaskRun navigation, pause/resume and evidence-based close;
- additive SQLite schema v35.

## Reused foundations

TaskRun remains the only execution unit. Goal progress refers to existing TaskRuns and evidence rather than creating a second runtime. Plan content may be stored as a revision or sourced from an existing Artifact. Completion evidence is a reference to existing Check, Artifact or Operation facts.

## Explicit non-goals

This implementation does not add Planning, Implementation, Verification, Repair or Reviewer Agent roles. It does not add Observer/Reflector workers, a background Goal Controller, automatic successors, a second recovery engine, generic RBAC or automatic Goal completion.

## Safety and performance

- Goal list/detail and `nextAction` do not call an LLM.
- Creating or approving a Goal does not start a TaskRun.
- Ordinary TaskRuns do not query the Goal repository.
- Goal closure requires valid evidence for every required criterion and a user decision.
- Goal evidence must point to an existing linked TaskRun and an existing Check, Artifact or Operation; passed Check evidence must be fresh and non-empty, and Operation evidence must be succeeded.
- Goal and evidence links cannot cross Workspace boundaries.
- Plan approval requires an explicit non-empty subset of known item IDs, and TaskRun links cannot exceed that approved slice.
- Revision decisions are bound to the exact revision content hash; stale hashes are rejected.
