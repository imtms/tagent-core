# Decision: Lightweight decision records

Status: implemented
Kind: process

## Problem

Cross-cutting decisions lived only in code review context and could be re-litigated after paths or maintainers changed. A full documentation governance system would cost more than this repository currently benefits from.

## Decision

TAgent uses `.agents/notes/{proposed,implemented,rejected}` with status in the path, one closed `Kind:` field, a small mandatory section skeleton, and one executable verifier. Non-trivial changes add or update their owning record. There is no generated index, translation triplet, archive manifest, or per-note sidecar.

## Alternatives considered

**Copy deepseek-harness Agent Notes exactly.** Rejected because bilingual pairing, immutable archive hashes, and a large classification tree solve scale and publishing needs TAgent does not have.

**Keep ad hoc Markdown in `docs/`.** Rejected because proposals, implemented decisions, and rejected ideas would remain indistinguishable.

**Use only git history.** Rejected because commits do not provide a maintained owner for alternatives and current consequences.

## Verification

`scripts/verify-agent-notes.mjs` rejects unknown folders, invalid filenames, status/path mismatch, unknown kinds, and missing or reordered sections. `npm run check:agents` is part of the repository `check` gate.

## Consequences

Decision maintenance becomes part of non-trivial changes with a small fixed cost. The structure can grow only when repository scale demonstrates a need.
