# TAgent Core v0.2.3 P0 implementation summary

Base: tag `v0.2.3`, commit `8464aef7fd34cddbb531b330db1cd28c1c1a9c97`.
Branch: `feat/oh-my-pi-p0`.

Implemented all four items from `../oh-my-pi-learning-assessment.md`, section `推荐路线图 / P0`. See `docs/P0_SCOPE_TRACEABILITY.md` for the authoritative item-by-item mapping.

1. Snapshot-bound `read` / `edit` and atomic multi-file `patch` with structured stale/precondition errors, descriptor-relative commit-time hash validation, staged rollback, check invalidation, durable Operation payload hashing, and idempotent receipt replay.
2. `ArtifactSinkPort` and workspace-backed durable command/tool output spill. Results expose bounded previews, Artifact identifiers/URIs, byte counts, SHA-256, source-truncation state, and discarded-byte metrics.
3. Core-owned `AGENTS.md` / allowlisted project-rule discovery with path containment, non-symlink and size checks, per-source SHA-256/precedence/reason metadata, aggregate context hash, Context Manifest records, and an explicit untrusted-policy prompt boundary.
4. Execution events/metrics: `workspace.edit.completed`, `workspace.edit.rejected`, and `tool.output.spilled`.

Deployment:

- Core: `127.0.0.1:3221`
- Web: `0.0.0.0:3220`
- Local release: `v023-p0-8464aef7fd34-20260806-214059`
- Backup: `/var/backups/tagent-core-memory/pre-p0-20260806-214059`
- Superseded `/opt` release directories were removed after backup and health verification.

Verification:

- `npm run build`: passed.
- TypeScript test type-check: passed.
- Focused P0/workspace/context tests: 24 passed.
- Affected integration set (`p0`, tools, context, Pi session, config, runtime): 98 passed.
- Core/Web health HTTP 200, writer ready, services active, `NRestarts=0`, SQLite integrity `ok`, schema 34.
- Same-origin `http://100.0.0.6:3220` succeeds; foreign Origin remains HTTP 403.

Operational note:

The host `/tmp` tmpfs was already full during verification. Tests were therefore run with a workspace-backed `TMPDIR`; two pre-existing runtime tests were changed to respect `TMPDIR` instead of hardcoding `/tmp`.
