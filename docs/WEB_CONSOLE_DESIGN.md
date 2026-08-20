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

Green `--accent` is reserved for primary actions, focus, selection marks, progress, and unread activity.
It is not a panel, card, header, or generic active-state background.

Operational color has one mapping:

- `info`: running or live.
- `success`: completed or passed.
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
- `data-tone="accent|info|success|warning|danger"` is the only semantic status-color interface.

Feature names should describe structure or behavior, not redefine colors, control heights, modal shells, or status variants.

## Information thresholds

Hide empty groups, zero-only metrics, redundant phase labels, static capability descriptions, and completed operational chrome with no inspectable evidence.

Keep standards, history, manifests, maintenance actions, and destructive controls behind disclosures or menus.
Current state appears before reference material.

Goals use one selector and one reading surface rather than an internal navigation rail.
Memory shows either the catalog or one detail view, never a nested split view. The type filter lives beside search; scope/count summaries stay hidden, and feedback, governance, and Forget remain behind the detail controls disclosure.
Skills use the upload target as their empty creation state.
Run details do not exist until a TaskRun exists.

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
- Workspace sidebar, switcher, composer, and Run details;
- Skills, shortcuts, Goals, Memory, and artifact dialogs when applicable;
- empty, loading, error, focus, and overflow states.

A passing build is not a visual pass.
