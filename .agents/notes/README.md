# Decision records

TAgent decision records preserve the rationale, rejected alternatives, consequences, and verification that source code cannot express. Their path is `{status}/YYYY-MM-DD-topic.md`.

## Status folders

- `proposed/`: not yet shipped or still under evaluation.
- `implemented/`: shipped and verified. Facts such as paths, types, and names stay current.
- `rejected/`: declined proposals retained only while the rationale prevents a plausible mistake.

No generated index or translated counterpart is required. The lifecycle folders are deliberately the inventory.

## Kinds

`Kind:` is one of `architecture`, `process`, `testing`, `feature`, `bug-fix`, or `simplification`. The kind describes the decision; the folder describes its status.

## Required format

Every record begins with exactly:

```markdown
# Decision: Title

Status: implemented
Kind: architecture
```

Implemented records contain, in order:

```markdown
## Problem
## Decision
## Alternatives considered
## Verification
## Consequences
```

Proposed records contain, in order:

```markdown
## Problem
## Proposal
## Alternatives considered
## Acceptance criteria
## Risks
```

Rejected records retain the proposed shape and add `## Rejection rationale` after `## Risks`. `Status:` must match the folder. `npm run check:agents` checks the closed tree, names, metadata, and section order.
