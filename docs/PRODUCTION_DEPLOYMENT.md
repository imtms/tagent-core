# Production deployment

Production hosts must never run `npm ci`, execute dependency install scripts, or
compile native dependencies. A release is built once in a compatible Linux x64,
Node.js `24.18.1` / ABI `137` environment that has a compiler toolchain, then the
verified directory is transferred as an immutable archive.

## Build the artifact

The `Production release artifact` GitHub Actions workflow runs
`scripts/build-release.sh`. It:

1. verifies Linux x64, Node `24.18.1`, ABI `137`, and npm 12 or newer;
2. installs from `package-lock.json` with lifecycle scripts enabled in CI, where
   `better-sqlite3` can fall back to `node-gyp` safely;
3. runs lint, type checks, tests, and the production build;
4. prunes development dependencies;
5. verifies `better_sqlite3.node`, opens and closes an in-memory database, and
   checks `dist/server.js` syntax;
6. writes `RELEASE_COMMIT` and `RELEASE_MANIFEST.json`, including the target
   runtime and SHA-256 hashes for the lockfile, package metadata, server bundle,
   and native binding;
7. uploads the tarball plus its SHA-256 sidecar.

The artifact name includes its full Git commit and compatibility target. Never
substitute an archive built on a developer workstation or a different Node ABI.

## Deploy the artifact

After independently checking the downloaded archive against its `.sha256` file,
run on the target host:

```sh
sudo scripts/deploy-release.sh \
  tagent-core-<commit>-linux-x64-node24-abi137.tar.gz \
  /opt/tagent-core \
  tagent-core.service
```

The deployer does not invoke npm. It extracts into a unique staging directory
under `/opt/tagent-core/releases`, and before changing `current` it verifies:

- exact Node version, ABI, platform, and architecture;
- `RELEASE_COMMIT` and the manifest commit;
- SHA-256 correspondence of `package-lock.json`, `package.json`, built server,
  and `better_sqlite3.node`;
- existence and loadability of the native binding by creating and closing an
  in-memory database;
- `node --check dist/server.js`.

Only after all checks pass is staging renamed to the new commit-addressed,
read-only release directory. `current` is then changed with an atomic symlink
rename, followed by one service restart.

If extraction or any preflight check fails, the script exits with a diagnostic
message. It does not touch `current`, does not restart systemd, and leaves the
currently running release intact. An existing release directory is never
modified or reused.

## Rollback

Keep the previous release directory. To roll back application code, atomically
point `current` at that directory and restart the service. Database compatibility
and the backup guidance in `RELEASE_CHECKLIST.md` still apply; do not run an old
binary against an incompatible schema.
