#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: deploy-release.sh <release.tar.gz> [release-root] [service]

Installs a prebuilt, verified release without running npm or compiling on the
production host. The default release root is /opt/tagent-core and the default
systemd service is tagent-core.service.
EOF
  exit 64
}

log() { printf '[deploy-release] %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

[[ $# -ge 1 && $# -le 3 ]] || usage
artifact=$(realpath "$1")
release_root=${2:-/opt/tagent-core}
service=${3:-tagent-core.service}
[[ -f "$artifact" ]] || fail "artifact does not exist: $artifact"
command -v node >/dev/null || fail "node is required to verify the prebuilt artifact"
command -v tar >/dev/null || fail "tar is required to unpack the artifact"
command -v systemctl >/dev/null || fail "systemctl is required to restart the service"

expected_node=24.18.1
expected_abi=137
expected_platform=linux
expected_arch=x64
[[ "$(node -p 'process.versions.node')" == "$expected_node" ]] || fail "Node version mismatch: expected $expected_node, got $(node -p 'process.versions.node')"
[[ "$(node -p 'process.versions.modules')" == "$expected_abi" ]] || fail "Node ABI mismatch: expected $expected_abi, got $(node -p 'process.versions.modules')"
[[ "$(node -p 'process.platform')" == "$expected_platform" ]] || fail "platform mismatch: expected $expected_platform, got $(node -p 'process.platform')"
[[ "$(node -p 'process.arch')" == "$expected_arch" ]] || fail "architecture mismatch: expected $expected_arch, got $(node -p 'process.arch')"

mkdir -p "$release_root/releases"
staging=$(mktemp -d "$release_root/releases/.staging.XXXXXXXX")
cleanup() { rm -rf "$staging"; }
trap cleanup EXIT

tar -xzf "$artifact" -C "$staging" --strip-components=1
[[ -f "$staging/RELEASE_MANIFEST.json" ]] || fail "artifact has no RELEASE_MANIFEST.json"
[[ -f "$staging/RELEASE_COMMIT" ]] || fail "artifact has no RELEASE_COMMIT"
commit=$(tr -d '\r\n' < "$staging/RELEASE_COMMIT")
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "invalid RELEASE_COMMIT: $commit"
[[ ! -e "$release_root/releases/$commit" ]] || fail "immutable release already exists: $release_root/releases/$commit"

# Every check below happens before current is touched or the service is restarted.
node "$staging/scripts/release-manifest.mjs" verify "$staging"
node --check "$staging/dist/server.js"

release_dir="$release_root/releases/$commit"
mv "$staging" "$release_dir"
trap - EXIT
chmod -R a-w "$release_dir"

next_link="$release_root/.current.$commit"
ln -s "releases/$commit" "$next_link"
mv -Tf "$next_link" "$release_root/current"

# The only restart is after all preflight checks and the atomic symlink switch.
systemctl restart "$service"
log "deployed immutable release $commit"
