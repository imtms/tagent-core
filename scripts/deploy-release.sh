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
node_binary=$(command -v node)
script_directory=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
trusted_verifier=${TAGENT_TRUSTED_RELEASE_VERIFIER:-"$script_directory/release-manifest.mjs"}
[[ -f "$trusted_verifier" && ! -L "$trusted_verifier" ]] || fail "trusted release verifier is unavailable: $trusted_verifier"

verify_native_as_service_user() {
  local release_directory=$1
  if [[ $(id -u) -eq 0 ]]; then
    local service_user=${TAGENT_SERVICE_USER:-tagent}
    command -v runuser >/dev/null || fail "runuser is required when deploying as root"
    id -u "$service_user" >/dev/null 2>&1 || fail "Core service user does not exist: $service_user"
    runuser -u "$service_user" -- env -i PATH="$PATH" \
      "$node_binary" "$trusted_verifier" verify-native "$release_directory"
    return
  fi
  env -i PATH="$PATH" "$node_binary" "$trusted_verifier" verify-native "$release_directory"
}

fsync_directory() {
  python3 - "$1" <<'PY'
import os, sys
descriptor = os.open(sys.argv[1], os.O_RDONLY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

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
cleanup() {
  # A failed verification may already have normalized the tree read-only.
  chmod -R u+w "$staging" 2>/dev/null || true
  rm -rf "$staging"
}
trap cleanup EXIT
tar -xzf "$artifact" -C "$staging" --strip-components=1 --no-same-owner --no-same-permissions
[[ -f "$staging/RELEASE_MANIFEST.json" ]] || fail "artifact has no RELEASE_MANIFEST.json"
[[ -f "$staging/RELEASE_COMMIT" ]] || fail "artifact has no RELEASE_COMMIT"
commit=$(tr -d '\r\n' < "$staging/RELEASE_COMMIT")
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "invalid RELEASE_COMMIT: $commit"
# Verification must never execute code supplied by the candidate as its own
# trust root. The deploy tool and its sibling verifier are installed together
# from an already trusted release (or supplied explicitly on first install).
node "$trusted_verifier" verify-integrity "$staging"
node --check "$staging/dist/host.js"
node --check "$staging/node_modules/@tagent/core-service/dist/host.js"
node --check "$staging/node_modules/@tagent/core-service/dist/generation-entry.js"

# mktemp creates the staging root as 0700. Normalize readability and remove
# every write bit before the directory becomes visible as an immutable release.
# Executable bits are retained only for directories and files already marked
# executable by the verified archive.
chmod -R a+rX,go-w,u-w "$staging"
verify_native_as_service_user "$staging"
# BSD/macOS requires the source directory itself to remain owner-writable for
# rename. The deployment directory is root-owned in production, so this does
# not grant the low-privilege Core account mutation access. All descendants
# are already immutable, and no candidate code runs after this point.
chmod u+w "$staging"

release_dir="$release_root/releases/$commit"
if [[ -e "$release_dir" || -L "$release_dir" ]]; then
  [[ -d "$release_dir" && ! -L "$release_dir" ]] || fail "immutable release path is not a directory: $release_dir"
  node "$trusted_verifier" verify-integrity "$release_dir"
  # Repair the only safe interrupted-install residue: verified content whose
  # final read-only mode normalization did not complete in an older installer.
  chmod -R a+rX,go-w,u-w "$release_dir"
  verify_native_as_service_user "$release_dir"
  log "immutable release $commit was already staged"
else
  mv "$staging" "$release_dir"
  trap - EXIT
  chmod u-w "$release_dir"
  fsync_directory "$release_root/releases"
fi
if [[ ! -e "$release_root/current" && ! -L "$release_root/current" ]]; then
  if ln -s "releases/$commit" "$release_root/current"; then
    fsync_directory "$release_root"
    log "initialized current to immutable release $commit"
  else
    current_target=$(readlink "$release_root/current" 2>/dev/null || true)
    [[ "$current_target" =~ ^releases/[0-9a-f]{40}$ ]] \
      || fail "current was initialized concurrently with an invalid target"
  fi
fi
log "staged immutable release $commit; request Core Host activation to switch a running installation"
