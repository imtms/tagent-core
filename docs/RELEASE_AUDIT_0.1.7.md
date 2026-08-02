# TAgent Core 0.1.7 Release Audit

## Scope

0.1.7 is a runtime reliability, supervision correctness, interaction, Artifact visibility, and controlled workflow-learning release. It is prepared from the 3220 working tree and is intended to become the shared release baseline for both maintained 3210 and 3220 instances.

## Primary improvements

### Runtime and Supervisor reliability

- Router, Supervisor, and Agent OpenAI-compatible SSE calls use progress-sensitive idle watchdogs. Each valid stream event refreshes the idle deadline; a separate absolute hard timeout still bounds the request.
- Long final deliveries are reviewed through a bounded head-tail UTF-8 projection. The opening context and ending delivery remain visible without sending an unbounded candidate to the Judge.
- Review projection metadata is separate from real model-output truncation. Only a final assistant `stopReason=length`, or semantic evidence in the visible ending, may establish genuine truncation.
- Projection-only truncation judgments receive one bounded correction and cannot create an unbounded Agent continuation loop.

### Web interaction and Artifacts

- Execution trace streams model output, available provider reasoning, and tool lifecycle details while a Run is active, remains independently scrollable, and collapses after terminal delivery.
- A TaskRun may enter durable `waiting_input` state and render typed text/textarea fields in chat. Submission persists the response and resumes the same TaskRun chain.
- Text and Markdown Artifacts can be opened directly in the Web workbench. Markdown uses the existing safe renderer; downloads remain available independently.
- Artifact preview is bounded to 5 MiB and local download to 50 MiB. Inline content, workspace-relative paths, local absolute paths, and `file://` sources are supported; remote sources are not server-fetched.

### Controlled workflow learning

- SQLite schema 16 adds workflow definitions, immutable revisions, bindings, application receipts, feedback, proposals, status history, experience observations, and per-Run learning policies.
- Explicit teaching remains a candidate until activation. Recall checks applicability, non-applicability, capability requirements, confidence, and provenance; recalled procedures grant no capability or approval.
- Successful and failed task outcomes are recorded separately. Repeated evidence may distill a candidate workflow, not an automatically active procedure.
- Harmful feedback suspends workflows; revision rollback and deletion are available. Deny-learning and metadata-only policy are supported, and common secret forms are redacted before persistence.

## Compatibility and migration

- Package version: `0.1.7`.
- SQLite schema: `16`, upgraded automatically on first startup.
- Code rollback alone is unsafe after schema migration. Before deployment, back up each SQLite database together with its `-wal` and `-shm` files, or use SQLite online backup. Restore the matching backup before running an older release.
- The existing trusted single-service/private-network deployment boundary remains unchanged.

## Release gates

The release commit must pass:

- `npm ci`
- `npm run lint`
- `npm run check`
- `npm test -- --run`
- `npm run build`
- `npm audit --omit=dev --audit-level=high`
- `npm audit --audit-level=high`
- `git diff --check`
- `npm run release:build` on Linux x64, Node 24.18.1 / ABI 137
- release manifest verification and immutable archive checksum generation
- post-deployment HTTP health and Web shell checks for both 3210 and 3220

## Deployment order

1. Commit and push the release preparation on `main`.
2. Create and push annotated tag `v0.1.7`.
3. Build and verify the immutable archive from that exact commit.
4. Back up the 3210 and 3220 databases before first schema-16 startup.
5. Update the 3210 checkout to the tagged commit and build it from the lockfile.
6. Restart 3210 and 3220, then verify health endpoints, Web shells, running PIDs, logs, and Git/tag alignment.
