# Decision: Keep application surfaces consumer-owned

Status: implemented
Kind: simplification

## Problem

Several persistence ports still exposed queries left behind by earlier recovery and compatibility implementations even though no production consumer called them. Concrete Store forwarding methods and bindings made those entries appear supported, tests called some solely because they were public, and architecture tests encoded exact file or call counts that became stale when valid production structure changed. A few constructors likewise retained dependencies that were never read.

## Decision

Limit application persistence ports and their SQLite bindings to capabilities required by current consumers. Remove forwarding methods with no production caller, keep aggregate hydration or diagnostic queries private or Store-internal when they still serve implementation and persistence tests, and migrate input recovery to the one request lookup that intentionally handles both pending and submitted states. Remove unused constructor dependencies and dead internal domain helpers.

Make architecture tests assert semantic ownership rather than repository size: required implementation files must exist, and all discovered production TaskRun transition callers must belong to the explicit authority set without hard-coding per-file call counts. Preserve intentionally dormant fenced capability ports and the retired Learning schema objects because dedicated architecture and compatibility tests identify those as maintained boundaries rather than accidental dead code.

## Alternatives considered

Keeping every concrete Store method on shared ports was rejected because it turns adapter implementation detail into cross-domain contract and makes obsolete APIs look supported. Deleting all low-reference symbols mechanically was rejected because dormant capability execution and immutable schema objects have explicit architectural or upgrade responsibilities. Deleting Store diagnostic helpers used by hydration or persistence tests was rejected because internal visibility, rather than removal, expresses their actual ownership. Exact source counts were rejected because they test repository shape rather than behavior or authority.

## Verification

`npm run check`, `npm run lint`, `npm test`, and `git diff --check` pass. One-off strict TypeScript checks with `--noUnusedLocals --noUnusedParameters` pass for every package and adapter workspace, and `npx --yes knip@latest --reporter compact` reports no unused file, dependency, or export. Targeted persistence, Store, Runtime, Skill, Attempt, package-architecture, TaskRun-transition, Memory, and approval regressions cover the narrowed bindings and retained behavior. Repository searches find no maintained external-action consume-once wording outside historical changelog entries and no removed compatibility method on a production port or binding.

## Consequences

Application contracts are smaller and communicate actual ownership, while SQLite may still keep internal queries needed to assemble aggregates or test durable state. Tests can admit new valid implementation files and transition call sites only when they satisfy the same authority invariant. The cleanup changes no user-visible behavior, public ABI, persistence schema, state protocol, or deployment tuple; future methods must be added from a concrete consumer requirement rather than copied wholesale from Store.
