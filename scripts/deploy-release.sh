#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: deploy-release.sh <release.tar.gz> [release-root] [service]

Installs a prebuilt, verified release without running npm or compiling on the
production host. The default release root is /opt/tagent-core and the default
systemd service is tagent-core.service.
USAGE
  exit 64
}

log() { printf '[deploy-release] %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

[[ $# -ge 1 && $# -le 3 ]] || usage
artifact=$(realpath "$1")
release_root=${2:-/opt/tagent-core}
service=${3:-tagent-core.service}
health_url=${TAGENT_HEALTH_URL:-http://127.0.0.1:3100/api/health}
health_attempts=${TAGENT_HEALTH_ATTEMPTS:-30}
[[ -f "$artifact" ]] || fail "artifact does not exist: $artifact"
for command in node tar systemctl curl python3; do command -v "$command" >/dev/null || fail "$command is required"; done

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
[[ ! -e "$release_root/releases/$commit" ]] || fail "immutable release already exists: $release_root/releases/$commit"
node "$staging/scripts/release-manifest.mjs" verify "$staging"
node --check "$staging/dist/server.js"

release_dir="$release_root/releases/$commit"
mv "$staging" "$release_dir"
trap - EXIT
chmod -R a-w "$release_dir"
old_target=$(readlink "$release_root/current" 2>/dev/null || true)
next_link="$release_root/.current.$commit"
ln -s "releases/$commit" "$next_link"
mv -Tf "$next_link" "$release_root/current"

rollback() {
  log "new release failed; restoring previous release"
  if [[ -n "$old_target" ]]; then
    rollback_link="$release_root/.rollback.$commit"
    ln -s "$old_target" "$rollback_link"
    mv -Tf "$rollback_link" "$release_root/current"
    systemctl restart "$service" || true
  fi
}

if ! systemctl restart "$service"; then rollback; fail "service restart failed"; fi
healthy=false
for ((attempt=1; attempt<=health_attempts; attempt++)); do
  if curl --fail --silent --show-error --max-time 2 "$health_url" >/dev/null; then healthy=true; break; fi
  sleep 1
done
if [[ "$healthy" != true ]]; then rollback; fail "health check failed: $health_url"; fi
log "deployed immutable release $commit"
