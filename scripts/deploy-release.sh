#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: deploy-release.sh <release.tar.gz> [release-root]

Installs a prebuilt, verified release without running npm or compiling on the
production host. The default release root is /opt/tagent-core. Existing
installations are staged only; Core Host performs activation and rollback.
On a first install, current is initialized so the Host has a boot target.
USAGE
  exit 64
}

log() { printf '[deploy-release] %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

[[ $# -ge 1 && $# -le 2 ]] || usage
artifact=$(realpath "$1")
release_root=${2:-/opt/tagent-core}
[[ -f "$artifact" ]] || fail "artifact does not exist: $artifact"
for command in node tar python3; do command -v "$command" >/dev/null || fail "$command is required"; done

[[ "$(node -p 'process.versions.node')" == "24.18.1" ]] || fail "Node version mismatch"
[[ "$(node -p 'process.versions.modules')" == "137" ]] || fail "Node ABI mismatch"
[[ "$(node -p 'process.platform')" == "linux" ]] || fail "platform mismatch"
[[ "$(node -p 'process.arch')" == "x64" ]] || fail "architecture mismatch"

python3 - "$artifact" <<'PY'
import posixpath, sys, tarfile
with tarfile.open(sys.argv[1], "r:gz") as archive:
    members = archive.getmembers()
    if not members:
        raise SystemExit("archive is empty")
    for member in members:
        normalized = posixpath.normpath(member.name)
        if member.name.startswith("/") or normalized == ".." or normalized.startswith("../"):
            raise SystemExit(f"unsafe archive path: {member.name}")
        if member.issym() or member.islnk():
            raise SystemExit(f"archive links are not supported: {member.name}")
        if not (member.isdir() or member.isfile()):
            raise SystemExit(f"unsupported archive entry: {member.name}")
PY

mkdir -p "$release_root/releases"
staging=$(mktemp -d "$release_root/releases/.staging.XXXXXXXX")
cleanup() { rm -rf "$staging"; }
trap cleanup EXIT
tar -xzf "$artifact" -C "$staging" --strip-components=1 --no-same-owner --no-same-permissions
[[ -f "$staging/RELEASE_MANIFEST.json" ]] || fail "artifact has no RELEASE_MANIFEST.json"
[[ -f "$staging/RELEASE_COMMIT" ]] || fail "artifact has no RELEASE_COMMIT"
commit=$(tr -d '\r\n' < "$staging/RELEASE_COMMIT")
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "invalid RELEASE_COMMIT: $commit"
node "$staging/scripts/release-manifest.mjs" verify "$staging"
node --check "$staging/dist/host.js"
node --check "$staging/node_modules/@tagent/core-service/dist/host.js"
node --check "$staging/node_modules/@tagent/core-service/dist/generation-entry.js"

release_dir="$release_root/releases/$commit"
if [[ -e "$release_dir" || -L "$release_dir" ]]; then
  [[ -d "$release_dir" && ! -L "$release_dir" ]] || fail "immutable release path is not a directory: $release_dir"
  node "$staging/scripts/release-manifest.mjs" verify "$release_dir"
  log "immutable release $commit was already staged"
else
  mv "$staging" "$release_dir"
  trap - EXIT
  chmod -R a-w "$release_dir"
fi
if [[ ! -e "$release_root/current" && ! -L "$release_root/current" ]]; then
  if ln -s "releases/$commit" "$release_root/current"; then
    log "initialized current to immutable release $commit"
  else
    current_target=$(readlink "$release_root/current" 2>/dev/null || true)
    [[ -n "$current_target" ]] || fail "current was initialized concurrently with an invalid target"
  fi
fi
log "staged immutable release $commit; request Core Host activation to switch a running installation"
