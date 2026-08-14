#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[build-release] %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

checked_out_commit=$(git rev-parse HEAD)
[[ "$checked_out_commit" =~ ^[0-9a-f]{40}$ ]] || fail "checked-out HEAD must resolve to a full Git commit"
if [[ -n "${RELEASE_COMMIT:-}" ]]; then
  [[ "$RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "RELEASE_COMMIT must be a full Git commit"
  [[ "$RELEASE_COMMIT" == "$checked_out_commit" ]] || fail "RELEASE_COMMIT must equal checked-out HEAD $checked_out_commit"
fi
commit=$checked_out_commit

[[ "$(node -p 'process.versions.node')" == "24.18.1" ]] || fail "Node 24.18.1 is required"
[[ "$(node -p 'process.versions.modules')" == "137" ]] || fail "Node ABI 137 is required"
[[ "$(node -p 'process.platform')" == "linux" ]] || fail "Linux is required"
[[ "$(node -p 'process.arch')" == "x64" ]] || fail "x64 is required"
[[ "$(npm --version | cut -d. -f1)" -ge 12 ]] || fail "npm 12 or newer is required"

core_output=${1:-"$PWD/tagent-core-$commit-linux-x64-node24-abi137.tar.gz"}
web_output=${2:-"$PWD/tagent-web-console-$commit.tar.gz"}
work=$(mktemp -d)
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
core_release="$work/tagent-core-$commit"
web_release="$work/tagent-web-console-$commit"

# Build native dependencies where a compiler is available. The production host
# never runs npm and only receives this already-built directory.
npm ci
npm run lint
npm run check
npm test -- --run
npm run build

# Install the Core production closure in isolated staging. Release assembly
# must not prune or otherwise mutate the caller's verified development tree.
install_root="$work/production-install"
mkdir -p "$install_root"
cp package.json package-lock.json "$install_root/"
for workspace_manifest in "$PWD"/packages/*/package.json "$PWD"/adapters/*/package.json "$PWD"/apps/*/package.json; do
  relative_manifest=${workspace_manifest#"$PWD/"}
  mkdir -p "$install_root/$(dirname "$relative_manifest")"
  cp "$workspace_manifest" "$install_root/$relative_manifest"
done
(
  cd "$install_root"
  npm ci --omit=dev --workspace @tagent/core-service --include-workspace-root
)

mkdir -p "$core_release/scripts"
cp -a package.json package-lock.json dist "$core_release/"
cp -a "$install_root/node_modules" "$core_release/"
# Core is an API-only artifact. Never carry a stale or historical SPA build
# into its staging directory, even when the build starts from a dirty tree.
rm -rf "$core_release/dist/web"
# npm workspaces are linked into node_modules during development. The release
# archive is self-contained and forbids symlinks, so materialize runtime
# workspace packages from their compiled output before creating the manifest.
workspace_inventory="$work/tagent-workspaces.tsv"
npm query .workspace --json | node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import path from "node:path";
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const workspaces = JSON.parse(input).filter(
    (workspace) => typeof workspace.name === "string" && workspace.name.startsWith("@tagent/"),
  );
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  if (byName.size !== workspaces.length) throw new Error("duplicate @tagent workspace name");
  const root = JSON.parse(readFileSync("package.json", "utf8"));
  const pending = Object.keys(root.dependencies ?? {}).filter((name) => name.startsWith("@tagent/"));
  const seen = new Set();
  const required = [];
  while (pending.length > 0) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    const workspace = byName.get(name);
    if (!workspace) throw new Error(`production dependency is not a workspace: ${name}`);
    seen.add(name);
    required.push(workspace);
    pending.push(...Object.keys(workspace.dependencies ?? {}).filter((dependency) => dependency.startsWith("@tagent/")));
  }
  required.sort((left, right) => left.name.localeCompare(right.name));
  for (const workspace of required) {
    const location = workspace.location;
    if (typeof location !== "string" || location.length === 0 || path.isAbsolute(location)
      || location.split(/[\\/]+/).includes("..") || /[\t\r\n]/.test(`${workspace.name}${location}`)) {
      throw new Error(`unsafe workspace inventory entry: ${workspace.name} -> ${String(location)}`);
    }
    process.stdout.write(`${workspace.name}\t${location}\n`);
  }
' > "$workspace_inventory"
[[ -s "$workspace_inventory" ]] || fail "npm workspace inventory contains no internal @tagent packages"

rm -rf "$core_release/node_modules/@tagent"
mkdir -p "$core_release/node_modules/@tagent"
while IFS=$'\t' read -r package_name workspace_location; do
  source="$PWD/$workspace_location"
  target="$core_release/node_modules/$package_name"
  [[ -f "$source/package.json" ]] || fail "workspace package.json is missing: $workspace_location/package.json"
  [[ -d "$source/dist" ]] || fail "workspace compiled dist is missing: $workspace_location/dist"
  [[ -L "$PWD/node_modules/$package_name" ]] || fail "expected npm workspace link: node_modules/$package_name"
  mkdir -p "$target"
  cp -a "$source/package.json" "$source/dist" "$target/"
  [[ -f "$target/package.json" ]] || fail "workspace materialization lost package.json: node_modules/$package_name/package.json"
  [[ -d "$target/dist" ]] || fail "workspace materialization lost dist: node_modules/$package_name/dist"
done < "$workspace_inventory"
# Deployment archives intentionally contain only regular files/directories.
# npm creates nested node_modules/.bin symlinks; runtime package resolution does
# not require them, and deploy-release.sh rejects archive links by policy.
find "$core_release/node_modules" -type d -name .bin -prune -exec rm -rf {} +
cp scripts/release-manifest.mjs scripts/deploy-release.sh scripts/gateway-readiness-probe.mjs "$core_release/scripts/"

release_links="$work/release-links.txt"
find "$core_release" -type l -print > "$release_links"
if [[ -s "$release_links" ]]; then
  while IFS= read -r link; do
    log "unexpected symbolic link: ${link#"$core_release/"}"
  done < "$release_links"
  fail "release staging must contain only regular files and directories"
fi

RELEASE_COMMIT="$commit" node scripts/release-manifest.mjs create "$core_release"
node --check "$core_release/dist/server.js"
node "$core_release/scripts/release-manifest.mjs" verify "$core_release"

tar -C "$work" -czf "$core_output" "tagent-core-$commit"
scripts/write-release-checksum.sh "$core_output"
log "created $core_output"

[[ -f apps/web-console/dist/index.html ]] || fail "Web Console build is missing: apps/web-console/dist/index.html"
mkdir -p "$web_release/scripts"
cp -a apps/web-console/package.json apps/web-console/dist "$web_release/"
cp scripts/release-manifest.mjs "$web_release/scripts/"
RELEASE_ARTIFACT=web-console RELEASE_COMMIT="$commit" node scripts/release-manifest.mjs create "$web_release"
node "$web_release/scripts/release-manifest.mjs" verify "$web_release"

tar -C "$work" -czf "$web_output" "tagent-web-console-$commit"
scripts/write-release-checksum.sh "$web_output"
log "created $web_output"
