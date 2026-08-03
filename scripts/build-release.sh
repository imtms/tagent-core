#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[build-release] %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

[[ "$(node -p 'process.versions.node')" == "24.18.1" ]] || fail "Node 24.18.1 is required"
[[ "$(node -p 'process.versions.modules')" == "137" ]] || fail "Node ABI 137 is required"
[[ "$(node -p 'process.platform')" == "linux" ]] || fail "Linux is required"
[[ "$(node -p 'process.arch')" == "x64" ]] || fail "x64 is required"
[[ "$(npm --version | cut -d. -f1)" -ge 12 ]] || fail "npm 12 or newer is required"

commit=${RELEASE_COMMIT:-$(git rev-parse HEAD)}
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "RELEASE_COMMIT must be a full Git commit"
output=${1:-"$PWD/tagent-core-$commit-linux-x64-node24-abi137.tar.gz"}
work=$(mktemp -d)
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
release="$work/tagent-core-$commit"

# Build native dependencies where a compiler is available. The production host
# never runs npm and only receives this already-built directory.
npm ci
npm run lint
npm run check
npm test -- --run
npm run build
npm prune --omit=dev

mkdir -p "$release/scripts"
cp -a package.json package-lock.json dist node_modules "$release/"
# Deployment archives intentionally contain only regular files/directories.
# npm creates nested node_modules/.bin symlinks; runtime package resolution does
# not require them, and deploy-release.sh rejects archive links by policy.
find "$release/node_modules" -type d -name .bin -prune -exec rm -rf {} +
cp scripts/release-manifest.mjs scripts/deploy-release.sh "$release/scripts/"
RELEASE_COMMIT="$commit" node scripts/release-manifest.mjs create "$release"
node --check "$release/dist/server.js"
node "$release/scripts/release-manifest.mjs" verify "$release"

tar -C "$work" -czf "$output" "tagent-core-$commit"
sha256sum "$output" > "$output.sha256"
log "created $output"
