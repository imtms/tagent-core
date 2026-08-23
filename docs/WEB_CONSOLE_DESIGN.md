# Web Console design

The Web Console is a quiet, technical workspace rather than a colorful dashboard.
Its reference is Hermit/Linear: flat neutral surfaces, compact typography, one restrained accent, and information revealed only when it becomes useful.

## Product shape

The desktop shell has five stable parts:

1. A 280px Workspace sidebar.
2. A 52px workspace bar.
3. One centered conversation plane.
4. One composer that contains input, its compact Review policy, and submit.
5. An on-demand Run details drawer.

Memory, Goals, Skills, shortcuts, and artifact previews are secondary tools.
They appear as menus, drawers, or modal workspaces instead of permanent columns.
The completion Review/Gate selector stays in the composer footer because its effect begins at submission and must remain visible at that decision point. It is remembered per Workspace, but is not duplicated in Workspace settings.
The workspace bar is the only persistent Run-state location. The composer does not repeat Running, and autosaved drafts do not create a permanent success message; persistence is expected background behavior.

The desktop Workspace sidebar does not collapse.
Run details never occupy a permanent third column.
On mobile, the Workspace sidebar and Run details are modal drawers over the same conversation plane.

Responsive support spans 320px phones through wide desktop screens. Visual validation samples 320px and 390px phones, a 768px tablet, and a 1280px desktop; the shell switches to drawers at 980px and shared touch geometry activates at 680px.

## Style ownership

`apps/web-console/src/app.css` is the only Web Console stylesheet.
`apps/web-console/src/main.tsx` is its only importer.

Keep layout, theme tokens, components, feature surfaces, and responsive rules in this file.
Do not add feature CSS, package themes, cascade override files, or compatibility layers.
When multiple elements share the same declaration set and specificity, express that ownership once with `:is(...)` instead of counting each feature as a separate selector.
When the file approaches the enforced size ceiling, simplify or remove rules instead of creating another stylesheet.

The first-paint shell in `apps/web-console/index.html` mirrors the application sidebar, bar, surface, border, text, and brand tokens.
This prevents the deployed loading frame from changing width, height, or color when React mounts.

## Visual system

Neutral surfaces carry almost all of the interface:

- `--bg` and `--surface` form the reading plane.
- `--sidebar` and `--muted` provide the only shallow surface steps; ordinary hover feedback reuses `--muted` instead of introducing another near-duplicate gray.
- `--border` and `--border-strong` provide hairline separation.
- `--text` and `--text-muted` carry hierarchy without opacity tricks.

Green `--accent` is reserved for primary actions, focus, selection marks, progress, live state, and successful completion.
It is not a panel, card, header, or generic active-state background.
`--focus-ring`, `--focus-border`, and `--focus-soft` derive every keyboard and composite-field focus effect from that same accent; features do not invent their own ring color, thickness, or glow.

Operational color has one mapping:

- `info`: running or live; it shares the restrained accent hue.
- `success`: completed or passed; it shares the restrained accent hue.
- `warning`: waiting, blocked, paused, or requiring review.
- `danger`: failed, cancelled, or interrupted.

Semantic colors appear as small text, dots, progress marks, or a narrow edge.
Apply `data-tone` to the status atom that communicates the state, not to an outer disclosure or ledger that owns neutral child text. Tool outcomes, Gate verdicts, Plan items, Checks, and current-operation state therefore share the same mapping without tinting their full row.
Do not create large semantic fills, gradients, or tinted dashboard regions.

All semantic text tokens retain at least WCAG AA 4.5:1 contrast on the theme surface. This includes muted text and warning labels; “quiet” must never mean barely visible.

Light and dark themes use opaque surfaces.
Dark elevated surfaces become slightly lighter and borders become translucent white.
Shadows are limited to real elevation: menus, drawers, and dialogs.
Popover and dialog shadows use the shared layered tokens; dark mode reduces their far-field opacity and relies more heavily on surface and border separation.

## Type and geometry

Use the six-size type ladder and seven-step spacing rhythm defined in `app.css`; the 10px micro size is reserved for tiny revision/count badges, not ordinary labels or metadata.
Do not introduce near-duplicate values to refine one component.

Use the sans family for interface copy, mono/tabular numerals for data, and the serif family only for the TAgent wordmark.
Technical identifiers, model names, timestamps, counts, and revisions retain exact casing.
Long empty-state and Goal headings use balanced wrapping; their short explanatory copy uses pretty wrapping so narrow layouts do not leave avoidable orphan words.

Use the shared radius ladder:

- 6px for compact controls and avatars.
- 10px for standard controls and rows.
- 16px for composers, dialogs, and other top-level containers.
- Pills only when the text benefits from a pill shape.

The normal control height is 36px.
Repeated leading icons use the shared 20px layout slot, micro metadata uses the shared 22px row, compact inline actions and avatars use the shared 28px geometry, and application bars, drawer/dialog headers, and search rows use the shared bar height instead of feature-specific values.
Operational dots use the shared 6px status indicator instead of feature-specific circles.
Controls and non-checkbox fields expand to the shared 44px touch height at mobile widths; icon-only actions, Workspace creation/search, menus, and form fields must not retain mixed 36px/44px rows.
The Workspace context menu keeps its five-column icon rhythm but expands to the mobile rail width so every icon choice also reaches that touch target.
The application bar keeps `min-width: 0` inside the conversation grid so the Workspace title truncates before 320px layouts clip fixed-size status and action targets.
Icons come from Lucide and use `ICON_SIZE`; component JSX does not choose raw icon sizes.

## Hierarchy and density

The conversation is the primary reading surface.
Assistant prose sits directly on that plane; user text uses a compact sender-side bubble.
Operational evidence stays in flat ledgers or Run details instead of creating a card wall.
The conversation feed reserves its horizontal gutters outside the 820px reading measure, so execution traces align with notices, approvals, and the composer instead of becoming an accidental narrower column.

Repeated rows use one surface with hairline separators.
Do not wrap every prompt, metric, rule, tool call, or setting in a separate rounded card.
Sidebar creation and search actions remain transparent on the sidebar surface until interaction; selected Workspace state is the only broad navigation fill.

Keep related labels and controls within 4–12px, then separate unrelated sections by 24px or more. Flat ledgers still need section gutters and paragraph rhythm; removing cards must never mean removing the whitespace that makes groups readable.

High-density secondary surfaces use one order: section heading, primary content, compact ledger, then optional disclosures. Run details, Memory operations, Goal criteria, and execution evidence must not invent separate heading, row, or status grammars.
Run usage stays in the API and diagnostics rather than occupying the Run details foreground. Message counts, token totals, and input/output arithmetic do not compete with the current outcome.

Use tiny uppercase tracked labels only where they genuinely group a list.
Do not stack an eyebrow, title, paragraph, and another empty-state title that all explain the same screen.

Empty states contain one quiet bounded mark, one foreground heading, one short explanation, and one next action. Their rows remain centered as a group instead of stretching spare height into arbitrary gaps.
If the main canvas explains an empty collection, the sidebar does not repeat the full explanation.
Conversation message actions follow the same restraint: Copy is an icon at rest and expands to text only for its brief success or failure result. Background Memory extraction in queued or running state stays out of the transcript; only a saved-memory result or extraction failure earns a message annotation.
Memory and Goals loading states use the same visible three-row skeleton stack and bar-height geometry; a loading container must never rely on empty zero-height elements.

## Shared component grammar

Use the existing shared primitives before introducing a feature-specific selector:

- `.control` is the base field and button geometry; `data-variant="primary"` identifies the one primary action.
- `.meta-line` owns muted inline metadata alignment and `.truncate` owns shrink-safe single-line ellipsis; feature selectors must not reimplement either declaration set.
- `.modal-backdrop`, `.modal`, and `.modal-workspace` own dialog elevation, spacing, and responsive behavior; Goals never borrows a Memory feature class for its shell.
- `.section-heading` owns headings in Goals, Memory, and other secondary workspaces.
- `.form-field`, `.form-columns`, `.inline-actions`, `.panel-empty`, and `.detail-disclosure` own the form, action, empty, and key/value disclosure grammar shared by Goals and Memory.
- `.memory-list` owns the separator-based list treatment for Memory results, feedback, and governance.
- `.run-step` is one reasoning-led execution stage; its nested `.tool-stack` is a subordinate ledger, not a second timeline.
- `data-tone="accent|info|success|warning|danger"` is the only semantic status-color interface.

Feature names should describe structure or behavior, not redefine colors, control heights, modal shells, or status variants.

## Information thresholds

Hide empty groups, zero-only metrics, redundant phase labels, static capability descriptions, and completed operational chrome with no inspectable evidence.

Keep standards, history, manifests, maintenance actions, and destructive controls in dedicated secondary views, disclosures, or menus.
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
Creating a new Goal temporarily replaces the selector value with an explicit draft state while preserving the previous selection. Cancel must return to that Goal; it must never leave a selected-looking toolbar above an empty canvas.
When the next action launches a Roadmap item, the action surface names that item and its concrete outcome instead of repeating a generic “run the next item” explanation. The operator should know what the primary button will start without opening the full Roadmap.
Roadmap review keeps every criterion mapping visible because it is approval evidence. After approval, each row keeps its title, outcome, status, and Start, Retry, or Open action visible while criterion mappings and verification share one explicit disclosure. This reduces the settled plan to a scan-friendly ledger without removing the information needed to audit it.
Completion criteria form one field group: one heading and explanation, one add action, then aligned criterion rows. At mobile widths the explanation and add action stack before the rows; criterion text occupies its own line above Required and remove controls.
The active Goal definition, current Run, concrete next action, and primary action stay visible above four stable views: Overview owns criteria and boundaries, Roadmap owns planning and execution, Activity owns linked TaskRuns/evidence/decisions, and Controls owns lifecycle, revision requests, and operation recovery. The Next action surface is the sole owner of Start, Retry, or Open for its target Roadmap item; that item's row keeps status and detail without repeating a second primary button. A queued item already owns its state in the Roadmap ledger, so it does not create a large Next action card with a second Queued eyebrow and disabled Queued button. Roadmap leading cells contain only order or approval selection, while the trailing status dot and label exclusively own execution state. Automatic sequencing and stop-on-block behavior do not become a permanent reminder below the ledger; the current action and item statuses communicate the operator's present state. The view suggested by the current action opens first, but every view remains one click away; compactness must come from switching information layers, not deleting operations or hiding the entire workspace in a chain of accordions. At mobile widths the four labels remain visible while their non-essential counters may disappear.
The Activity tab owns the aggregate audit count, so a populated Activity view begins directly with its actual Linked TaskRuns, Evidence, or Decision history groups instead of repeating a second aggregate heading. Linked Runs lead with their Roadmap item or Workspace guidance, and Evidence leads with the readable criterion and source type; truncated Run, Artifact, and criterion IDs do not become primary copy. Controls separates Lifecycle from an explicit Revision request group; concise Target and Reason fields sit under that functional name so simplification never makes the operation ambiguous.
Completed and cancelled Goals omit the expired lifecycle-and-revision heading, show the terminal explanation directly, and retain operation receipt recovery below it.
Requesting changes must target the active Definition or Roadmap and retain an operator reason; it must not require leaving the Goal workspace. Durable Goal operation receipts remain recoverable by request ID in Controls. Receipt lookup exposes state and identity first, keeps raw payload/result/error behind a nested disclosure, and never encourages repeating an interrupted operation whose outcome is uncertain.
The Console owns the request ID before definition revision, Roadmap save, or Roadmap generation dispatch, persists the latest ID per Goal in browser storage, and pre-fills recovery with it after switching Goals or reloading. A recovery field that asks for an ID the interface never exposed is not a complete feature. Queued or claimed Supervisor Inbox work is projected onto the Roadmap before a TaskRun attaches; its item and primary action read `Queued`, and duplicate launch, revision, and lifecycle actions stay locked with a contextual explanation rather than relying on a backend conflict. Once the TaskRun attaches, ordinary Run progress becomes authoritative.
Memory has four stable views: Catalog for the loaded Record/Topic directory, Recall for cross-tier semantic retrieval, Core for the stable projection, and Operations for maintenance and recovery. Export and Add memory remain global actions. A Record or Topic detail replaces the active Catalog or Recall surface with a clear return path to its source while retaining those global actions; it never creates a nested split view. Detail itself uses stable Overview, Metadata, and Controls views instead of a top-level accordion chain. An inactive Record or deleted Topic opens Controls first so required governance or recovery is immediately discoverable.
The Catalog shows one storage layer at a time through an explicit Cards / Topics selector and its input filters only the loaded directory. Both layers remain one action away, but equivalent Record and Topic text must not be stacked into a duplicated mobile reading wall. Recall owns a separate cue and kind selector because semantic retrieval across Hot, Warm, and Cold is a different task. Recall results belong to the submitted cue and kind; changing either invalidates the old result instead of relabeling stale evidence.
The Recall tab explains semantic retrieval once: its idle surface keeps one compact heading, one short prompt, and the cue and kind controls in the same section; submitted results lead directly with the queried phrase. It does not split the prompt into a second large empty-state panel or repeat the same task as a `Semantic recall` or `Dynamic recall` eyebrow, description, empty-state title, and empty-state paragraph.
The Memory header exposes only non-zero lifecycle counts. Kind and status filters share the search toolbar; correction, confirmation, helpful/wrong feedback, disputed resolution, reactivation, and Forget remain in detail Controls. Forget must expose immediate Undo for the returned grace period; recovery by Record/Topic ID remains in Memory operations because forgotten records are intentionally absent from the catalog. JSON export is a quiet toolbar action.
Every Topic descriptor remains inspectable and governable even when no canonical Cold page has been published. The detail identifies that state plainly, exposes descriptor metadata and Forget/Restore controls, and adds the canonical document and revision storage only when they exist.
Record provenance, semantic identity, lifecycle, validity, storage identity, and Topic relationships belong in one two-column hairline ledger inside the Metadata view rather than separate cards or stacked paragraphs. Recall routing, score construction, embedding degradation, policy transforms, and candidate outcomes belong in one diagnostics disclosure; its summary omits a suffix when no useful aggregate count exists. No-result guidance points to the Catalog view rather than claiming the catalog is below the results. Metadata remains one click away while complete operator data stays available. Generated Record or Topic titles that merely prefix the body or description with a Memory kind are treated as labels and must not repeat the same content in catalog, Recall, or detail views. A Record summary that repeats either the visible title or body is likewise omitted.
Record and Topic details use one quiet mono identity line above the title. Kind, tier, status, scores, revision, token count, and storage availability stay complete in that line instead of becoming a separate pill plus a second metadata row; uppercase tracking remains reserved for section labels rather than long data strings.
The editable Core Memory projection is directly visible in the Core view and uses the canonical full-width input boundary. A multiline editor must never fall back to the browser's narrow default textarea geometry.
Its content header names the Core Memory snapshot and current revision once; the Core tab and Generate, Regenerate, or Save action provide the remaining context without a second explanatory eyebrow.
Core Memory save and generation, Recall, governance, feedback, Forget and Restore share the panel's busy authority, and feedback refreshes the selected Record projection so visible lifecycle metadata never trails a successful mutation. A deleted Record exposes recovery only; stale rating or correction actions must not remain clickable beside Restore.
The Operations view uses the same outer gutter as the catalog, keeps Reindex and Record/Topic ID restore directly reachable, keeps job counts in section headings, and gives each desktop job a full-width status/source/metrics row. At mobile widths, metrics move below and align with the source instead of compressing all three fields.
Its tab owns the aggregate job count and its Durable index and Recent captures headings own group counts. The content header therefore uses one quiet Maintenance and recovery label instead of restating the page name and aggregate total.
Skills use the upload target as their empty creation state.
Run details do not exist until a TaskRun exists. The expanded history row is the drawer's only Run identity summary: it owns goal, status, attempt, and recency, so the content below never repeats that block. Collapsed goals use a single bounded line; expanding the row reveals the complete wrapping goal for touch and keyboard users, while hover also exposes the full value. The remaining visible order follows operator value: a current abnormal outcome or waiting/stalled execution state, Artifacts, optional preserved work, Task contract, non-actionable review history, disclosed execution evidence, then Context sources. The actionable outcome and its historical Review details are separate sections so artifacts can sit between them instead of being buried below audit machinery. A pending User input or Approval card in the primary work area exclusively owns its prompt, reason, and action; opening Run details while that interaction is pending reveals only historical Review details instead of a second foreground reminder. The Task contract summary counts only criteria that add information; generated criteria that merely prefix and repeat the Run goal, contract summary, or source input disappear. Its expanded body leads with the remaining criteria, then promotes a distinct included scope and explicit `Not included` boundaries; a scope that merely repeats the Run goal or contract summary also disappears. Parser decisions, intent, and relation are technical routing metadata under one closed `Routing details` disclosure. Artifacts outrank the machinery that produced them, and a truncated Artifact title remains recoverable through its preview action and title. A normally running tool stays exclusively in the conversation's live Execution trace; Run details create a Current operation section only for waiting or stalled execution, paired with compact time since its last activity so the operator can judge abnormality. Preserved work is one closed disclosure containing only an inspectable last tool or partial response, never event or Transcript sequence counters; its summary does not repeat those child labels.

Supervisor decisions and completion Gates form one Review surface. A blocked Run already carries its state in the history row, so its content says `Why it stopped` and leads with the explanation instead of repeating a second `Blocked` label. A single blocker shows a matched Plan, Check, or Artifact title only when it adds readable context; machine keys such as `release-evidence` and redundant kind labels do not sit above the reason. Multiple blockers retain category and key distinctions because those labels support scanning. Other approval-bound or non-matching decisions expose one readable action, rationale, and completion blockers before the `Review details` disclosure; that disclosure never repeats the same action as a second decision record. When a concise Run reason and a different technical evaluator rationale describe the same outcome, the Run reason becomes the visible explanation and the recorded rationale moves behind that disclosure; the interface never highlights both. Equivalent status, rationale, summary, category, criterion reason, and blocker copy appears once at the most specific surface, including when one value merely wraps the other in machine phrasing. Gate summaries that only restate `Completion is blocked`, passed, failed, or deferred disappear because the Gate header already owns that verdict. Successful settlement does not create a second verdict card and remains reachable through the disclosure summary. Supervisor implementation counters such as meaningful changes, consecutive failures, and repeated operations never create a Review surface or become operator-facing evidence. A disclosure without a useful aggregate result omits its summary suffix instead of filling it with “recorded” or “available” chrome. One Gate failure reads `Failed`; counts appear only when they distinguish multiple Gates or failures. Static review rules appear only after a Gate evaluation exists and remain behind a closed `Review policy` disclosure after Evaluation history; its summary names the active profile and rule count so it cannot be confused with the Task contract's acceptance criteria. Per-Gate evaluator identity does not trail every evaluation; reason code, evaluator model, confidence, and non-default retry attempt stay in one closed `Review provenance` disclosure. Criterion coverage keeps the readable criterion and state, plus its reason only when that reason is not already the primary blocker; raw evidence reference IDs remain in the contract data and do not trail the explanation as non-interactive foreground text. Evaluation history never precedes the current outcome. A Run with no persisted decision or Gate evaluation omits the Review surface instead of displaying progress-monitoring chrome.

Inside the conversation's `Execution trace`, tool events represented by durable Transcript calls are deduplicated by tool-call identity; only still-unrecorded live calls remain in the current stage. Successful completion is the default and does not repeat `Completed` or `Done` on every row, while running, pending, and failed states remain explicit. Long names use the shared single-line truncation grammar and expose their full value on demand. Only populated arguments, results, or structured errors create call details; empty arguments and missing results never produce `{}`, `No result recorded`, or an expandable empty body. Arguments, results, and errors scroll only inside their own code surface.

Context presents sources in operator language. Its summary reports `n total` and promotes only non-zero omissions, avoiding a mechanical `Context sources · n sources` echo; ordinary selection counts remain inside the disclosure. Because the outer summary already owns the omission count, the inner `Omitted sources` row names the group without repeating that number. Used, omitted, added, and removed sources group repeated entries by readable kind, role, name, and reason; internal source IDs never become foreground copy. Known selection-policy reasons are translated into short operator language, while distinct project-rule paths and Skill names remain visible. Empty manifests disappear. Snapshot selection and grouped source changes remain inspectable through one disclosure instead of a duplicate change notice, while default attempt 1 stays implicit and hashes, estimated tokens, and retained snapshot counts stay under `Context provenance`. Execution evidence is also a disclosure whose summary says only `Complete`, a compact open count, or `Needs attention`; multiple attention items keep only their distinguishing count. Blocked Plan and Check rows count as attention, while skipped rows are terminal rather than open. Successful Plan and Check rows use their check icon as the visible state and retain the exact status in their accessible name rather than repeating `Done` or `Passed` down the ledger. A single successful Continuation likewise omits `#1` and `Completed`; ordinal appears only when it distinguishes multiple handoffs, and lease ownership never becomes visible status copy. Continuation reasons use a zero-minimum stacked row so neither status nor long handoff identifiers can widen the drawer.

The conversation's `Execution trace` is the only foreground owner of reasoning, tool calls, and model output. Run details therefore do not repeat a second Tool calls ledger; they stay focused on contract, current outcome, artifacts, evidence, and context selection.

Supervisor queue rows keep one request summary, defer state, and immediate actions visible. When the machine summary differs from the submitted request, the original request remains inspectable inside `Task details` instead of becoming a duplicate primary paragraph. Intent, relation, priority, confidence, target Run, routing reason, and acceptance criteria are diagnostics rather than primary controls, so they stay in that same closed disclosure. Generated URLs and continuous text wrap inside the row at narrow widths.

Approval ownership follows the same hierarchy. The section heading communicates that a decision is required and adds a pending count only when multiple actions need distinguishing; each card then leads with the actual approval reason. Action type and non-default Attempt remain quiet context, so the card never restates “needs your approval” or adds a second generic human-checkpoint label before the operator can see what is being authorized.

Requested user input likewise leads with the specific prompt and fields. A prompt, field description, or placeholder that exactly repeats the field label or another visible value is omitted. Its safety boundary remains one short muted sentence: supplying answers resumes the Run but does not approve external actions.

The Execution trace groups the durable transcript by reasoning stage. Its single hairline outer frame owns the whole trace; stage separators and the inset tool ledger express hierarchy without turning every call into a card. The chevron communicates disclosure, so the collapsed summary needs only its stage count rather than an “expand to inspect” instruction. Attempt 1 is the default and stays implicit; only retries show their attempt number. Historical reasoning stages stay closed by default even while the outer live trace is open, so earlier thought does not push the current stage out of view. Subsequent tool calls belong to that stage until model output settles it; a later reasoning item begins the next stage. Tool arguments and results remain disclosures inside the stage ledger, and live reasoning/tools/output occupy one final live stage. Their grid tracks and sections must use zero-minimum sizing so long commands, paths, JSON, and results scroll inside the code surface instead of widening the trace. Markdown tables likewise own their horizontal scroll boundary inside the reading plane; a wide result must never widen the message, drawer, or page.

## Interaction

Every control needs hover, active, disabled where applicable, and visible `:focus-visible` treatment.
Hover may strengthen a quiet action but must never change its geometry or be the only way to discover an action or its success/failure feedback. Workspace row actions and message copy therefore remain visible without a pointing-device hover and expand to the shared touch target on mobile.
The mobile application bar applies that same 44px target to navigation, Workspace title, Run status, Skills, and Workspace actions. Run details uses a checklist icon with a small semantic status marker instead of collapsing to an unexplained dot; the marker communicates state while the icon communicates destination.
Disabled controls use the shared muted text, border, and surface instead of stacking opacity over already-muted colors; unavailable must remain legible rather than visually disappearing into its background.
Error, success, warning, and Undo feedback share the neutral `.notice` boundary. Generated copy wraps and shrinks before its action, while the action retains the shared control geometry. Success feedback expires automatically; both success and error feedback can be dismissed explicitly, so stale notices never become permanent application chrome.
Motion is limited to fast color, border, opacity, and transform changes.
Controls and chevrons use `--duration-fast`, drawers use `--duration-base`, and skeleton/live-state breathing uses `--duration-pulse`; features do not choose one-off timings for the same effect class.
Menus share the fast `surface-in` entrance, while dialog backdrops and surfaces share the base entrance; reduced-motion mode collapses all of them to an effectively immediate state change.
Respect reduced motion and never animate layout dimensions.

Modal workspaces and dialogs trap focus, restore focus on close, close with Escape, and make background content inert. Memory, Goals, Workspace Switcher, Shortcuts, Skill editing, and Artifact preview all render through the shared document-level portal instead of inheriting the shell or a drawer's width, clipping, or stacking context. A nested dialog makes its parent workspace inert, then returns focus to the launching control before the parent focus trap resumes.
Dialog headers use one title group and the shared `ICON_SIZE` ladder. Scrollable dialog bodies consume the remaining height while action footers stay at the bottom of a full-screen mobile dialog; long titles truncate on one line and expose the full value on demand.
Composite borderless inputs move focus feedback to their enclosing control: Workspace search uses the shared accent underline and Memory search uses the shared focus border and soft ring. A nested outline may be cancelled only when that enclosing `:focus-within` boundary is present and enforced by the style contract.
Mobile drawers must not remain modal after crossing the desktop breakpoint.

## Validation

Run:

```bash
npm run check -w @tagent/web-console
npm run build -w @tagent/web-console
npx eslint apps/web-console/src apps/web-console/scripts --max-warnings=0
```

The style check enforces the single stylesheet entrypoint, the token scales, raw-color ownership, semantic 4.5:1 contrast, status mapping, content-column alignment, boot-shell parity, mobile touch targets, retired layout names, duplicate declaration removal, and the limited `!important` exceptions. Class ownership is checked in both directions: JSX cannot use unstyled classes and CSS cannot retain selectors for classes no JSX renders.

The current complexity ceilings are deliberately small: at most 800 lines, 420 rules, 500 unique selectors, and 1450 declarations. Treat these as pressure to merge or delete exceptions, not as capacity to fill.

For every visible change, render and inspect:

- desktop light and dark;
- 390px mobile light and dark;
- Workspace sidebar, switcher, composer, and dense Run details;
- Skills, shortcuts, Goals, Memory, and artifact dialogs when applicable;
- multi-stage Tool Calls, Goal criteria, and populated Memory job ledgers;
- empty, loading, error, focus, and overflow states.

A passing build is not a visual pass.
