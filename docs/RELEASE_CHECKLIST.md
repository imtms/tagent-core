# Release Checklist

## Scope

This checklist applies to source releases. TAgent Core is not published to npm in `0.1.x`; `private: true` is intentional.

## Before tagging

If long-term memory is included in the release, complete [MEMORY_RELEASE_CHECKLIST.md](MEMORY_RELEASE_CHECKLIST.md) in addition to the general checks below. Memory-off compatibility is a required release gate because long-term memory is opt-in. If Learning is included, also verify [LEARNING.md](LEARNING.md) and the reviewable [LEARNING_RELEASE_COVERAGE.md](LEARNING_RELEASE_COVERAGE.md) matrix: Memory-off must force Learning and its Worker off; passive mode must continue observation/distillation without Workflow injection; execution mode must still require human approval; the persisted switch must survive restart.

1. Confirm `package.json` and `package-lock.json` use the target version.
2. Update `CHANGELOG.md`, `README.md`, `docs/STATUS.md`, and known limitations.
3. Confirm the worktree is clean and the release commit is on `main`.
4. Run `npm ci` from the lockfile in a clean Node.js `24.18.1` and npm `12` or newer environment.
5. Run `npm run lint`, `npm run check`, `npm test -- --run`, and `npm run build`.
6. Build the production archive with `scripts/build-release.sh` on Linux x64, Node `24.18.1` / ABI `137`, in an environment that has the compiler toolchain required by native dependencies. Do not install or compile dependencies on a production host; follow [PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md).
7. Run production and full dependency audits at high severity. Pi's upstream shrinkwrap issue is accepted for `main` development if it recurs, but stable release remains blocked until the lockfile audits cleanly.
8. Start the built server with a temporary SQLite database and workspace; verify `/api/health`, `/api/config/status`, session creation, run history, and the Web shell.
9. Verify desktop and mobile layouts, immediate optimistic message visibility, workspace-switch fencing, safe Markdown, collapsed/expanded tool activity, and no horizontal overflow.
10. Submit representative opaque automation markers (`release-<digits>`, `ui-sync-<digits>`) and confirm HTTP 422 with no Message or TaskRun persistence; confirm a natural-language release request is still admitted.
11. Confirm dynamic token tiers are guidance checkpoints, the configured hard ceiling remains enforced, and the Web labels checkpoint versus maximum correctly.
12. Confirm no credentials, `.env` files, databases, logs, screenshots, or temporary artifacts are tracked.

## Tag and publish

1. Create an annotated tag named `v<version>`.
2. Push `main` and the tag.
3. Let `.github/workflows/release.yml` rerun the release gate and create a GitHub release using the matching changelog section.
4. Verify the GitHub release points to the expected commit and has the intended stable/prerelease state.

## Rollback

Code rollback does not downgrade the SQLite schema. Before upgrading:

1. Stop TAgent Core cleanly.
2. Copy the SQLite database and its `-wal`/`-shm` files together, or use SQLite `.backup` while the service is running.
3. Record the previous Git tag, Node.js version, and environment configuration names without recording secret values.

To roll back, stop the service, restore the matching database backup, check out the previous tag, run `npm ci && npm run build`, and restart. Never run an older binary against a database whose schema version it rejects.
