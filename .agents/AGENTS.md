# TAgent decision records

Before a non-trivial change, search [the decision tree](notes/README.md) for an existing owner. A change is non-trivial when it alters behavior, an inter-package contract, a durable or wire format, lifecycle ownership, security policy, or testing strategy.

- Add a proposal before substantial undecided work.
- Move the record to `implemented/` only when its claims match shipped code and verification.
- Move a declined proposal to `rejected/` while its rationale still prevents a plausible mistake.
- Update an existing owner instead of creating a second record for the same decision.
- Record real alternatives and trade-offs. Do not reconstruct fictional debate.
- Treat code and executable tests as behavioral authority; keep implemented records synchronized with their current paths and names.

Run `npm run check:agents` after changing this tree.
