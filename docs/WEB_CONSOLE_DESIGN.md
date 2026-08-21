# Web Console design

The Web Console is a quiet, technical workspace rather than a colorful dashboard.
Its reference is Hermit/Linear: flat neutral surfaces, compact typography, one restrained accent, and information revealed only when it becomes useful.

## Product shape

The desktop shell has five stable parts:

1. A 280px Workspace sidebar.
2. A 52px workspace bar.
3. One centered conversation plane.
4. One composer that contains input, its compact Review policy, live state, and submit.
5. An on-demand Run details drawer.

Memory, Goals, Skills, shortcuts, and artifact previews are secondary tools.
They appear as menus, drawers, or modal workspaces instead of permanent columns.
The completion Review/Gate selector stays in the composer footer because its effect begins at submission and must remain visible at that decision point. It is remembered per Workspace, but is not duplicated in Workspace settings.

The desktop Workspace sidebar does not collapse.
Run details never occupy a permanent third column.
On mobile, the Workspace sidebar and Run details are modal drawers over the same conversation plane.

## Style ownership

`apps/web-console/src/app.css` is the only Web Console stylesheet.
`apps/web-console/src/main.tsx` is its only importer.

Keep layout, theme tokens, components, feature surfaces, and responsive rules in this file.
Do not add feature CSS, package themes, cascade override files, or compatibility layers.
When the file approaches the enforced size ceiling, simplify or remove rules instead of creating another stylesheet.

The first-paint shell in `apps/web-console/index.html` mirrors the application sidebar, bar, surface, border, text, and brand tokens.
This prevents the deployed loading frame from changing width, height, or color when React mounts.

## Visual system

Neutral surfaces carry almost all of the interface:

- `--bg` and `--surface` form the reading plane.
- `--sidebar`, `--muted`, and `--hover` provide shallow surface steps.
- `--border` and `--border-strong` provide hairline separation.
- `--text` and `--text-muted` carry hierarchy without opacity tricks.

Green `--accent` is reserved for primary actions, focus, selection marks, progress, live state, and successful completion.
It is not a panel, card, header, or generic active-state background.

Operational color has one mapping:

- `info`: running or live; it shares the restrained accent hue.
- `success`: completed or passed; it shares the restrained accent hue.
- `warning`: waiting, blocked, paused, or requiring review.
- `danger`: failed, cancelled, or interrupted.

Semantic colors appear as small text, dots, progress marks, or a narrow edge.
Do not create large semantic fills, gradients, or tinted dashboard regions.

Light and dark themes use opaque surfaces.
Dark elevated surfaces become slightly lighter and borders become translucent white.
Shadows are limited to real elevation: menus, drawers, and dialogs.

## Type and geometry

Use the five-size type ladder and seven-step spacing rhythm defined in `app.css`.
Do not introduce near-duplicate values to refine one component.

Use the sans family for interface copy, mono/tabular numerals for data, and the serif family only for the TAgent wordmark.
Technical identifiers, model names, timestamps, counts, and revisions retain exact casing.

Use the shared radius ladder:

- 6px for compact controls and avatars.
- 10px for standard controls and rows.
- 16px for composers, dialogs, and other top-level containers.
- Pills only when the text benefits from a pill shape.

The normal control height is 36px.
Touch targets are 44px at mobile widths.
Icons come from Lucide and use `ICON_SIZE`; component JSX does not choose raw icon sizes.

## Hierarchy and density

The conversation is the primary reading surface.
Assistant prose sits directly on that plane; user text uses a compact sender-side bubble.
Operational evidence stays in flat ledgers or Run details instead of creating a card wall.

Repeated rows use one surface with hairline separators.
Do not wrap every prompt, metric, rule, tool call, or setting in a separate rounded card.

Keep related labels and controls within 4–12px, then separate unrelated sections by 24px or more. Flat ledgers still need section gutters and paragraph rhythm; removing cards must never mean removing the whitespace that makes groups readable.

High-density secondary surfaces use one order: section heading, primary content, compact ledger, then optional disclosures. Run details, Memory operations, Goal criteria, and execution evidence must not invent separate heading, row, or status grammars.
At mobile widths, numeric Run metrics use two readable columns rather than squeezing three values into a wrapping row.

Use tiny uppercase tracked labels only where they genuinely group a list.
Do not stack an eyebrow, title, paragraph, and another empty-state title that all explain the same screen.

Empty states contain one mark, one heading, one short explanation, and one next action.
If the main canvas explains an empty collection, the sidebar does not repeat the full explanation.

## Shared component grammar

Use the existing shared primitives before introducing a feature-specific selector:

- `.control` is the base field and button geometry; `data-variant="primary"` identifies the one primary action.
- `.modal-backdrop` and `.modal` own dialog elevation, spacing, and responsive behavior.
- `.section-heading` owns headings in Goals, Memory, and other secondary workspaces.
- `.memory-list` owns the separator-based list treatment for Memory results, feedback, and governance.
- `.run-step` is one reasoning-led execution stage; its nested `.tool-stack` is a subordinate ledger, not a second timeline.
- `.run-metrics` owns wrap-safe observational counts and never compresses all usage into one unbreakable line.
- `data-tone="accent|info|success|warning|danger"` is the only semantic status-color interface.

Feature names should describe structure or behavior, not redefine colors, control heights, modal shells, or status variants.

## Information thresholds

Hide empty groups, zero-only metrics, redundant phase labels, static capability descriptions, and completed operational chrome with no inspectable evidence.

Keep standards, history, manifests, maintenance actions, and destructive controls behind disclosures or menus.
Current state appears before reference material.

### Feature completeness contract

Compactness means progressive disclosure and contextual controls, never deleting a workflow. A refactor is incomplete unless every operation below remains reachable from the Web Console and its result, failure, or durable receipt remains inspectable.

| Surface | Primary path | Complete secondary path |
| --- | --- | --- |
| Goals | list/open Goals; create and revise a Definition; review criteria and boundaries | approve or request changes against the exact revision; pause, resume, close, or cancel |
| Goal Roadmap | generate or author a Roadmap; edit and select approved items | start, retry, or open the bound TaskRun; inspect per-item verification and criterion mapping |
| Goal audit | current action and progress | linked Runs, evidence, decisions, raw operation receipt recovery by request ID |
| Memory catalog | status, local filtering, stable pagination, Record and Topic detail | dynamic Recall with routing/score diagnostics; JSON export |
| Memory lifecycle | capture; approve, reject, resolve, reactivate, and correct Records | confirm/helpful/wrong feedback; Forget Record or Topic; immediate Undo and ID-based restore |
| Memory context | full provenance, semantic identity, lifecycle, validity, relationships, and Cold storage | generate, edit, and save Core Memory; reindex and inspect capture/reindex jobs |

Contextual simplification is allowed: for example, a Memory detail replaces catalog filters with `All memory` while keeping Export and Add memory visible. The underlying operation must never become unreachable or depend on undocumented API use.

Operational state uses one shared dot-and-label grammar, not feature-specific colored pills. A terminal TaskRun status appears in the top bar and Run details; do not repeat it as a feed card or beside the composer. The composer shows live state only while execution is running, while pending input and approval retain their actionable surfaces. Long machine-generated status reasons show one readable clause first and retain the raw diagnostic behind a disclosure.

Goals use one selector and one reading surface rather than an internal navigation rail.
Completion criteria form one field group: one heading and explanation, one add action, then aligned criterion rows. At mobile widths the explanation and add action stack before the rows; criterion text occupies its own line above Required and remove controls.
The active Goal definition and current Run stay visible in the hero. Completion criteria open when Goal review or closure needs them; an unapproved or revision-required Roadmap opens for review, then collapses to a completed/approved summary after approval. Linked TaskRuns, evidence, and decisions share one chronological Activity and audit disclosure, while pause, close, cancel, and revision requests share one lifecycle disclosure. Requesting changes must target the active Definition or Roadmap and retain an operator reason; it must not require leaving the Goal workspace.
Durable Goal operation receipts remain recoverable by request ID from a secondary disclosure. Receipt lookup must expose state and identity first, keep raw payload/result/error behind a nested disclosure, and never encourage repeating an interrupted operation whose outcome is uncertain.
Memory shows either the catalog or one detail view, never a nested split view. The type filter lives beside search; a detail replaces catalog-only filters with a clear back action while retaining global Export and Add actions. Raw scope and backend descriptions stay hidden, and feedback, governance, and Forget remain behind the detail controls disclosure.
The Memory header exposes only non-zero lifecycle counts. Kind and status filters share the search toolbar; correction, confirmation, helpful/wrong feedback, disputed resolution, reactivation, and Forget remain in the detail disclosure. Forget must expose immediate Undo for the returned grace period; recovery by Record/Topic ID remains in Memory operations because forgotten records are intentionally absent from the catalog. JSON export is a quiet toolbar action.
Record provenance, semantic identity, lifecycle, validity, storage identity, and Topic relationships belong in one metadata disclosure rather than separate cards. Recall routing, score construction, embedding degradation, policy transforms, and candidate outcomes belong in one diagnostics disclosure. Both stay collapsed until inspected, but complete operator data must remain available. Generated Record or Topic titles that merely prefix the body or description with a Memory kind are treated as labels and must not repeat the same content in catalog, Recall, or detail views.
Memory operations use the same outer gutter as the catalog, keep job counts in section headings, and give each desktop job a full-width status/source/metrics row. At mobile widths, metrics move below and align with the source instead of compressing all three fields.
Skills use the upload target as their empty creation state.
Run details do not exist until a TaskRun exists. Continuation rows use zero-minimum grids and wrap long handoff identifiers so neither the row nor its content can widen the drawer.

The Execution trace groups the durable transcript by reasoning stage. Its single hairline outer frame owns the whole trace; stage separators and the inset tool ledger express hierarchy without turning every call into a card. Subsequent tool calls belong to that stage until model output settles it; a later reasoning item begins the next stage. Tool arguments and results remain disclosures inside the stage ledger, and live reasoning/tools/output occupy one final live stage. Their grid tracks and sections must use zero-minimum sizing so long commands, paths, JSON, and results scroll inside the code surface instead of widening the trace. Gate audit does not restate an accepted Supervisor verdict; it retains blockers, standards, and evaluation history for inspection.

## Interaction

Every control needs hover, active, disabled where applicable, and visible `:focus-visible` treatment.
Motion is limited to fast color, border, opacity, and transform changes.
Respect reduced motion and never animate layout dimensions.

Modal workspaces and drawers trap focus, restore focus on close, close with Escape, and make background content inert.
Mobile drawers must not remain modal after crossing the desktop breakpoint.

## Validation

Run:

```bash
npm run check -w @tagent/web-console
npm run build -w @tagent/web-console
npx eslint apps/web-console/src apps/web-console/scripts --max-warnings=0
```

The style check enforces the single stylesheet entrypoint, the token scales, raw-color ownership, status mapping, boot-shell parity, mobile touch targets, retired layout names, duplicate declaration removal, and the limited `!important` exceptions. Class ownership is checked in both directions: JSX cannot use unstyled classes and CSS cannot retain selectors for classes no JSX renders.

The current complexity ceilings are deliberately small: at most 800 lines, 420 rules, 500 unique selectors, and 1450 declarations. Treat these as pressure to merge or delete exceptions, not as capacity to fill.

For every visible change, render and inspect:

- desktop light and dark;
- 390px mobile light and dark;
- Workspace sidebar, switcher, composer, and dense Run details;
- Skills, shortcuts, Goals, Memory, and artifact dialogs when applicable;
- multi-stage Tool Calls, Goal criteria, and populated Memory job ledgers;
- empty, loading, error, focus, and overflow states.

A passing build is not a visual pass.
