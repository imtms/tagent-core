# P0 reliable execution additions

This v0.2.3-based development branch adds the Core-owned P0 capabilities identified in `../oh-my-pi-learning-assessment.md`. Development was isolated from the existing deployment; after implementation, the user explicitly instructed that the verified P0 release replace the 3220/3221 deployment, which was done after a stop-time backup.

## Snapshot-aware workspace edits

- `read` returns `snapshotId` and `contentHash`.
- `edit` requires both values.
- `patch` applies multiple files after every snapshot and hunk passes preflight.
- The descriptor-relative helper verifies hashes again at commit time, stages all replacements, and rolls visible renames back if a commit step fails.
- Operation canonical payloads contain the complete snapshot-bound patch; successful receipt replay does not write again.
- Rejections use `workspace.edit_stale` or `workspace.edit_precondition_failed` and emit `workspace.edit.rejected`.

## Durable large-output Artifacts

- Oversized tool output receives a bounded head/tail preview.
- Bash captures its complete combined byte stream to a temporary workspace file and persists it through `ArtifactSinkPort` before returning.
- Results include `artifactId`, `artifactUri`, `sha256`, `totalBytes`, `storedBytes`, `shownBytes`, `truncatedAtSource`, and `outputDiscardedBytes`.
- The default hard limit is 16 MiB (`TAGENT_TOOL_ARTIFACT_MAX_BYTES`). Content beyond the configured hard limit is saved up to the limit and reported with `truncatedAtSource=true` plus a nonzero `outputDiscardedBytes`; it is never presented as complete.
- `tool.output.spilled` provides execution metrics and durable evidence linkage.

## Core-owned project context

- `AGENTS.md` is discovered by Core by default. Additional allowlisted files can be set with `TAGENT_PROJECT_RULE_FILES`.
- Every selected source is a regular non-symlink file under the workspace and is size bounded.
- Path, SHA-256, precedence, selection reason, byte count, and an aggregate context hash enter the Context Manifest.
- Project rules are explicitly marked untrusted and cannot grant capabilities, approve operations, or override TaskRun/completion authority.
