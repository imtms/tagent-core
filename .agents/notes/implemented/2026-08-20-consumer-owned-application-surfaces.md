# Decision: Keep application surfaces consumer-owned

Status: implemented
Kind: simplification

## Problem

Several persistence ports still exposed queries left behind by earlier recovery and compatibility implementations even though no production consumer called them. Concrete Store forwarding methods and bindings made those entries appear supported, tests called some solely because they were public, and architecture tests encoded exact file or call counts that became stale when valid production structure changed. A few constructors likewise retained dependencies that were never read. The generic CapabilityCommand handler, its fenced SQLite repository, and their public package surfaces later remained deliberately dormant, but no production composition root adopted them; the active Runtime tool pipeline and Store approval activation became the sole maintained effect boundary.

## Decision

Limit application persistence ports and their SQLite bindings to capabilities required by current consumers. Remove forwarding methods with no production caller, keep aggregate hydration or diagnostic queries private or Store-internal when they still serve implementation and persistence tests, and migrate input recovery to the one request lookup that intentionally handles both pending and submitted states. Remove unused constructor dependencies and dead internal domain helpers.

Make architecture tests assert semantic ownership rather than repository size: required implementation files must exist, and all discovered production TaskRun transition callers must belong to the explicit authority set without hard-coding per-file call counts. Remove the unused CapabilityCommand domain, execution handler and ports, fenced SQLite repository, dedicated package subpath, and tests that only exercised or proved the dormancy of that alternate path. Preserve the retired Learning schema objects because exact-schema validation and upgrade compatibility still require their byte-for-byte baseline.

Restrict consumer-owned type barrels to the types their callers actually import. Share byte-compatible mechanics within a consumer boundary when their behavior is identical: profile-operation claiming and audit settlement, Inbox and Skill response mapping, Core Client query encoding, and the namespace-parameterized cursor codec now each have one implementation.

## Alternatives considered

Keeping every concrete Store method on shared ports was rejected because it turns adapter implementation detail into cross-domain contract and makes obsolete APIs look supported. Keeping the dormant CapabilityCommand stack as a future extension point was rejected because it duplicated active approval, operation-receipt, fencing, and settlement concepts without a production consumer. Deleting all low-reference symbols mechanically remains rejected because immutable schema objects have an upgrade responsibility. Cross-domain policy and ABI definitions remain separate when their independent ownership is intentional, even if their present shapes match. Deleting Store diagnostic helpers used by hydration or persistence tests was rejected because internal visibility, rather than removal, expresses their actual ownership. Exact source counts were rejected because they test repository shape rather than behavior or authority.

## Verification

`npm run check`, `npm run lint`, `npm test`, `npm run build`, and `git diff --check` pass. One-off strict TypeScript checks with `--noUnusedLocals --noUnusedParameters` pass for every package and adapter workspace, and `npx --yes knip@latest --reporter compact` reports no unused file, dependency, or export. Targeted persistence, Store, Runtime, Skill, Attempt, package-architecture, TaskRun-transition, Memory, approval, Operator profile, Web, and Core Client regressions cover the narrowed bindings and retained behavior. Representative pre-refactor profile and Operator Read cursor/snapshot tokens remain byte-for-byte identical. Repository searches find no CapabilityCommand or dormant execution surface in production or package exports and no removed compatibility method on a production port or binding.

## Consequences

Application contracts are smaller and communicate actual ownership, while SQLite may still keep internal queries needed to assemble aggregates or test durable state. Tests can admit new valid implementation files and transition call sites only when they satisfy the same authority invariant. The cleanup changes no user-visible behavior, published Gateway ABI, persistence schema, state protocol, or deployment tuple; it removes a private package subpath that had no production caller. Future methods and alternate execution abstractions must be added from a concrete consumer requirement rather than copied wholesale from Store or retained speculatively.
