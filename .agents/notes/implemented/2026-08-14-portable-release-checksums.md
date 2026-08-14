# Decision: Portable release checksum files

Status: implemented
Kind: bug-fix

## Problem

The release builder hashed an absolute output path. GitHub Release therefore attached correct archive digests but `.sha256` files containing the ephemeral runner path, so `sha256sum -c` failed after users downloaded the archive and checksum elsewhere.

## Decision

Release checksum files contain the archive basename only. `scripts/write-release-checksum.sh` changes into the archive directory before invoking `sha256sum`; both Core and Web release paths use that helper. A downloaded archive and its checksum must verify from any directory without rewriting the checksum file.

## Alternatives considered

**Keep absolute paths and document a manual hash comparison.** Rejected because checksum files should be directly executable verification artifacts, not runner-local logs.

**Post-process the first checksum field only.** Rejected because changing into the archive directory is simpler, preserves standard `sha256sum` output, and handles output directories containing spaces.

**Replace the already published tag.** Rejected because a stable annotated tag is immutable release identity. A new patch release supersedes the non-portable assets.

## Verification

`tests/release-deploy.test.ts` creates an archive in an arbitrary directory containing a space, asserts the checksum contains only the basename, and verifies it with `sha256sum -c` from that directory. The release gate downloads both published archive/checksum pairs and verifies them without path rewriting.

## Consequences

Release users can verify assets with the standard checksum command after download. The checksum helper is a build-time script and does not enter the Core or Web runtime artifacts.
