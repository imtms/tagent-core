#!/usr/bin/env bash
set -Eeuo pipefail

archive=${1:?usage: write-release-checksum.sh ARCHIVE}
[[ -f "$archive" ]] || { printf 'release archive is missing: %s\n' "$archive" >&2; exit 1; }

directory=$(dirname "$archive")
filename=$(basename "$archive")

# Keep the checksum portable after download. Hash from the archive directory so
# sha256sum records only the basename, never a CI runner or local absolute path.
(cd "$directory" && sha256sum -- "$filename") > "$archive.sha256"
