# Spawn Proposal removal and migration

Schema 27 removes the independent `SpawnProposal` subsystem.

## Replacement model

Related work discovered while a TaskRun is active is persisted as a normal Session Inbox item. Its routing analysis carries:

- `targetRunId`: the parent TaskRun;
- `relation`: `parallel`, `follow_up`, `derived`, or `depends_on`;
- objectives, acceptance criteria, scope, non-goals, decision reason, and router version.

When the Inbox item starts, the complete analysis is copied into `TaskRun.contract`, and a `taskrun_edges` row preserves the parent-child relation.

## Scheduling and approval

Related tasks remain queued by default, preserving the single-active-TaskRun scheduling model. A user may start them normally after the current TaskRun completes.

Starting a `parallel` Inbox item while its parent is still running requires the existing Supervisor approval flow:

1. `POST /api/sessions/:sessionId/inbox/:itemId/parallel-start-request`;
2. a pending `approval_requests` record is created;
3. a human approves it through `POST /api/approval-requests/:id/approve`;
4. approval launches the Inbox item and records the TaskRun edge.

No parallel task is launched merely because the router or Agent identifies it.

## Removed interfaces

The following no longer exist:

- `SpawnProposal` types and status machine;
- `spawn_proposals` runtime table;
- `task_run(action="spawn_proposal")`;
- `/api/runs/:id/spawn-proposals`;
- `/api/spawn-proposals/:id/*`;
- `spawn_taskrun` Supervisor actions;
- Spawn Proposal Web controls.

## Upgrade migration

On upgrade, Schema 27 checks for a legacy `spawn_proposals` table:

- `proposed` and `approved` rows become queued related Session Inbox items;
- `rejected` rows become deleted Inbox audit receipts;
- already `spawned` rows retain their historical TaskRun and `taskrun_edges` records and are not requeued;
- the legacy table is then dropped.

The migration is idempotent through deterministic Inbox request IDs and the Session Inbox uniqueness constraint.
