import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  FileCheck2,
  Pencil,
  Plus,
  Target,
  Trash2,
  X,
} from "lucide-react";
import {
  api,
  type WorkspaceGoal,
  type WorkspaceGoalDefinition,
  type WorkspaceGoalPlan,
  type WorkspaceGoalPlanItem,
  type WorkspaceGoalSummary,
} from "./api";

const blankDefinition = (): WorkspaceGoalDefinition => ({
  title: "",
  outcome: "",
  scope: [],
  nonGoals: [],
  criteria: [{ key: "criterion-1", title: "", required: true }],
  completionPolicy: "user_confirm",
});

const blankPlan = (): WorkspaceGoalPlan => ({
  summary: "",
  items: [{ id: "item-1", title: "", outcome: "", verification: "" }],
});

type GoalDecisionKind = "approve_goal" | "approve_plan" | "request_change" | "pause" | "resume" | "close" | "cancel";
type EditorMode = "create" | "definition" | "plan" | null;

export function GoalsPanel({
  workspaceId,
  onClose,
  onOpenRun,
}: {
  workspaceId: string;
  onClose: () => void;
  onOpenRun?: (runId: string) => void;
}) {
  const [items, setItems] = useState<WorkspaceGoalSummary[]>([]);
  const [selected, setSelected] = useState<WorkspaceGoal | null>(null);
  const [editor, setEditor] = useState<EditorMode>(null);
  const [definition, setDefinition] = useState<WorkspaceGoalDefinition>(blankDefinition);
  const [plan, setPlan] = useState<WorkspaceGoalPlan>(blankPlan);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);

  const refresh = async (selectId?: string) => {
    const nextItems = await api.workspaceGoals(workspaceId);
    setItems(nextItems);
    const targetId = selectId ?? selected?.id ?? nextItems[0]?.id;
    if (targetId && nextItems.some((item) => item.id === targetId)) {
      setSelected(await api.workspaceGoal(targetId));
    } else {
      setSelected(null);
    }
  };

  useEffect(() => {
    let active = true;
    setSelected(null);
    setEditor(null);
    setError("");
    setNotice("");
    setBusy(true);
    void api.workspaceGoals(workspaceId)
      .then(async (next) => {
        if (!active) return;
        setItems(next);
        if (next[0]) {
          const first = await api.workspaceGoal(next[0].id);
          if (active) setSelected(first);
        }
      })
      .catch((cause) => { if (active) setError(message(cause)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [workspaceId]);

  const openGoal = async (goalId: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setSelected(await api.workspaceGoal(goalId));
      setEditor(null);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (
    kind: GoalDecisionKind,
    target = selected?.definition,
    approvedItemIds: string[] = [],
    reason = "",
  ) => {
    if (!selected || !target || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await api.decideWorkspaceGoal(selected.id, target.id, target.contentHash, kind, approvedItemIds, reason);
      setSelected(next);
      setEditor(null);
      await refresh(next.id);
      setNotice(decisionNotice(kind));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const beginDefinitionEdit = () => {
    const current = selected?.definition?.content as WorkspaceGoalDefinition | undefined;
    setDefinition(current ? clone(current) : blankDefinition());
    setEditor(selected ? "definition" : "create");
    setError("");
    setNotice("");
  };

  const beginPlanEdit = () => {
    const current = selected?.plan?.content as WorkspaceGoalPlan | undefined;
    setPlan(current ? clone(current) : blankPlan());
    setEditor("plan");
    setError("");
    setNotice("");
  };

  return <div className="memory-overlay goal-overlay" role="dialog" aria-modal="true" aria-labelledby="workspace-goals-title">
    <button className="memory-backdrop" onClick={onClose} aria-label="Close Goals" />
    <section className="memory-center goal-center">
      <header className="memory-header goal-header">
        <div className="memory-heading-icon"><Target size={21} /></div>
        <div>
          <span className="eyebrow">Workspace outcomes</span>
          <h2 id="workspace-goals-title">Goals</h2>
          <p>Define the outcome, approve a bounded plan, and track verified progress.</p>
        </div>
        <div className="memory-header-actions">
          <span className="memory-live"><span />{items.length} total</span>
          <button className="icon-button" onClick={onClose} aria-label="Close Goals"><X size={18} /></button>
        </div>
      </header>

      <div className="goal-shell">
        <aside className="goal-sidebar">
          <button className="memory-primary goal-new-button" onClick={() => {
            setSelected(null);
            setDefinition(blankDefinition());
            setEditor("create");
            setError("");
            setNotice("");
          }}><Plus size={15} />New Goal</button>
          <GoalNavigation items={items} selectedId={selected?.id} busy={busy} onOpen={openGoal} />
        </aside>

        <main className="goal-main">
          {error && <div className="memory-alert error goal-alert">{error}</div>}
          {notice && <div className="memory-alert success goal-alert">{notice}</div>}
          {editor === "create" || editor === "definition" ? <GoalDefinitionForm
            definition={definition}
            setDefinition={setDefinition}
            busy={busy}
            editing={editor === "definition"}
            onCancel={() => setEditor(null)}
            onSave={async () => {
              setBusy(true);
              setError("");
              setNotice("");
              try {
                if (selected) {
                  await api.reviseWorkspaceGoal(selected.id, definition);
                  await refresh(selected.id);
                  setNotice("Definition updated. Review the new revision before planning.");
                } else {
                  const goal = await api.createWorkspaceGoal(workspaceId, definition);
                  setSelected(goal);
                  await refresh(goal.id);
                  setNotice("Goal draft created. No TaskRun was started.");
                }
                setEditor(null);
              } catch (cause) {
                setError(message(cause));
              } finally {
                setBusy(false);
              }
            }}
          /> : editor === "plan" && selected ? <GoalPlanForm
            plan={plan}
            setPlan={setPlan}
            busy={busy}
            onCancel={() => setEditor(null)}
            onSave={async () => {
              setBusy(true);
              setError("");
              setNotice("");
              try {
                await api.addWorkspaceGoalPlan(selected.id, plan);
                await refresh(selected.id);
                setEditor(null);
                setNotice("Plan saved. Select the items you want to approve.");
              } catch (cause) {
                setError(message(cause));
              } finally {
                setBusy(false);
              }
            }}
          /> : selected ? <GoalView
            goal={selected}
            busy={busy}
            decide={decide}
            onEditDefinition={beginDefinitionEdit}
            onEditPlan={beginPlanEdit}
            onOpenRun={onOpenRun}
          /> : <GoalEmpty busy={busy} onCreate={beginDefinitionEdit} />}
        </main>
      </div>
    </section>
  </div>;
}

function GoalNavigation({
  items,
  selectedId,
  busy,
  onOpen,
}: {
  items: WorkspaceGoalSummary[];
  selectedId?: string;
  busy: boolean;
  onOpen: (goalId: string) => Promise<void>;
}) {
  const groups = [
    { label: "Needs attention", items: items.filter((item) => item.status === "draft" || item.status === "ready_to_close") },
    { label: "In progress", items: items.filter((item) => item.status === "active" || item.status === "paused") },
    { label: "Ended", items: items.filter((item) => item.status === "completed" || item.status === "cancelled") },
  ].filter((group) => group.items.length > 0);

  if (!items.length) return <div className="goal-sidebar-empty"><Target size={18} /><p>No Goals yet.</p><small>Create one when work needs a durable outcome across TaskRuns.</small></div>;

  return <nav className="goal-nav" aria-label="Workspace Goals">
    {groups.map((group) => <section key={group.label}>
      <h3>{group.label}<span>{group.items.length}</span></h3>
      {group.items.map((goal) => {
        const progress = goal.requiredCriteria ? Math.round(goal.verifiedCriteria / goal.requiredCriteria * 100) : 0;
        return <button
          type="button"
          className={selectedId === goal.id ? "selected" : ""}
          key={goal.id}
          onClick={() => void onOpen(goal.id)}
          disabled={busy}
        >
          <span className={`goal-nav-dot ${statusTone(goal.status)}`} />
          <span className="goal-nav-copy">
            <strong>{goal.title}</strong>
            <small>{statusLabel(goal.status)} · {goal.verifiedCriteria}/{goal.requiredCriteria} verified</small>
            <span className="goal-mini-progress"><i style={{ width: `${progress}%` }} /></span>
          </span>
        </button>;
      })}
    </section>)}
  </nav>;
}

function GoalEmpty({ busy, onCreate }: { busy: boolean; onCreate: () => void }) {
  return <div className="goal-empty">
    <div><Target size={24} /></div>
    <span className="eyebrow">Long-term work</span>
    <h2>Create a clear Workspace outcome</h2>
    <p>Goals keep direction and evidence together while TaskRun remains the only execution unit.</p>
    <button className="memory-primary" disabled={busy} onClick={onCreate}><Plus size={15} />Create Goal</button>
  </div>;
}

function GoalDefinitionForm({
  definition,
  setDefinition,
  busy,
  editing,
  onSave,
  onCancel,
}: {
  definition: WorkspaceGoalDefinition;
  setDefinition: (value: WorkspaceGoalDefinition) => void;
  busy: boolean;
  editing: boolean;
  onSave: () => Promise<void>;
  onCancel: () => void;
}) {
  const updateCriterion = (index: number, patch: Partial<WorkspaceGoalDefinition["criteria"][number]>) => {
    setDefinition({
      ...definition,
      criteria: definition.criteria.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    });
  };
  const addCriterion = () => setDefinition({
    ...definition,
    criteria: [...definition.criteria, { key: nextKey(definition.criteria.map((item) => item.key), "criterion"), title: "", required: true }],
  });
  const valid = Boolean(
    definition.title.trim()
    && definition.outcome.trim()
    && definition.criteria.length
    && definition.criteria.every((item) => item.key.trim() && item.title.trim())
    && new Set(definition.criteria.map((item) => item.key.trim())).size === definition.criteria.length,
  );

  return <div className="goal-form">
    <FormHeading
      eyebrow={editing ? "Definition revision" : "New Goal"}
      title={editing ? "Update the outcome" : "What should this Workspace achieve?"}
      description={editing ? "Saving creates a new revision and makes the previous approval stale." : "Start with the outcome and how you will know it is complete."}
    />
    <label className="goal-field"><span>Title</span><input autoFocus maxLength={200} value={definition.title} onChange={(event) => setDefinition({ ...definition, title: event.target.value })} placeholder="A short, outcome-focused name" /></label>
    <label className="goal-field"><span>Outcome</span><textarea rows={4} maxLength={4000} value={definition.outcome} onChange={(event) => setDefinition({ ...definition, outcome: event.target.value })} placeholder="Describe the Workspace state you want to reach" /></label>

    <fieldset className="goal-editor-section">
      <legend>Completion criteria</legend>
      <p>Keep only the checks that matter for deciding whether the Goal is done.</p>
      <div className="goal-criteria-editor">
        {definition.criteria.map((criterion, index) => <div className="goal-criterion-editor" key={`${criterion.key}:${index}`}>
          <span>{index + 1}</span>
          <input aria-label={`Criterion ${index + 1}`} value={criterion.title} onChange={(event) => updateCriterion(index, { title: event.target.value })} placeholder="A verifiable completion condition" />
          <label className="goal-required"><input type="checkbox" checked={criterion.required} onChange={(event) => updateCriterion(index, { required: event.target.checked })} />Required</label>
          <button className="goal-icon-action" type="button" aria-label={`Remove criterion ${index + 1}`} disabled={definition.criteria.length === 1} onClick={() => setDefinition({ ...definition, criteria: definition.criteria.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={14} /></button>
        </div>)}
      </div>
      <button className="goal-secondary-action" type="button" onClick={addCriterion}><Plus size={14} />Add criterion</button>
    </fieldset>

    <details className="goal-disclosure" open={Boolean(definition.scope.length || definition.nonGoals.length)}>
      <summary><span><ChevronRight size={14} />Scope and boundaries</span><small>Optional</small></summary>
      <div className="goal-form-columns">
        <label className="goal-field"><span>Included <small>one item per line</small></span><textarea rows={4} value={definition.scope.join("\n")} onChange={(event) => setDefinition({ ...definition, scope: lines(event.target.value) })} /></label>
        <label className="goal-field"><span>Not included <small>one item per line</small></span><textarea rows={4} value={definition.nonGoals.join("\n")} onChange={(event) => setDefinition({ ...definition, nonGoals: lines(event.target.value) })} /></label>
      </div>
    </details>

    <div className="goal-form-actions"><button onClick={onCancel} disabled={busy}>Cancel</button><button className="memory-primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? "Saving…" : editing ? "Save revision" : "Create draft"}</button></div>
  </div>;
}

function GoalPlanForm({
  plan,
  setPlan,
  busy,
  onSave,
  onCancel,
}: {
  plan: WorkspaceGoalPlan;
  setPlan: (value: WorkspaceGoalPlan) => void;
  busy: boolean;
  onSave: () => Promise<void>;
  onCancel: () => void;
}) {
  const update = (index: number, patch: Partial<WorkspaceGoalPlanItem>) => setPlan({
    ...plan,
    items: plan.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
  });
  const add = () => setPlan({
    ...plan,
    items: [...plan.items, { id: nextKey(plan.items.map((item) => item.id), "item"), title: "", outcome: "", verification: "" }],
  });
  const valid = Boolean(
    plan.summary.trim()
    && plan.items.length
    && plan.items.every((item) => item.id.trim() && item.title.trim() && item.outcome.trim() && item.verification.trim())
    && new Set(plan.items.map((item) => item.id.trim())).size === plan.items.length,
  );

  return <div className="goal-form">
    <FormHeading eyebrow="Plan revision" title="Plan the next bounded steps" description="Saving does not start work. You will choose which items to approve next." />
    <label className="goal-field"><span>Plan summary</span><textarea autoFocus rows={3} value={plan.summary} onChange={(event) => setPlan({ ...plan, summary: event.target.value })} placeholder="Describe the approach in a few sentences" /></label>
    <div className="goal-plan-editor">
      {plan.items.map((item, index) => <section key={`${item.id}:${index}`}>
        <header><div><span>Step {index + 1}</span><strong>{item.title.trim() || "Untitled step"}</strong></div><button className="goal-icon-action" type="button" aria-label={`Remove plan step ${index + 1}`} disabled={plan.items.length === 1} onClick={() => setPlan({ ...plan, items: plan.items.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={14} /></button></header>
        <label className="goal-field"><span>Title</span><input value={item.title} onChange={(event) => update(index, { title: event.target.value })} placeholder="One TaskRun-sized step" /></label>
        <label className="goal-field"><span>Expected result</span><textarea rows={2} value={item.outcome} onChange={(event) => update(index, { outcome: event.target.value })} /></label>
        <label className="goal-field"><span>Verification</span><textarea rows={2} value={item.verification} onChange={(event) => update(index, { verification: event.target.value })} /></label>
      </section>)}
    </div>
    <button className="goal-secondary-action" type="button" onClick={add}><Plus size={14} />Add step</button>
    <div className="goal-form-actions"><button onClick={onCancel} disabled={busy}>Cancel</button><button className="memory-primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? "Saving…" : "Save plan"}</button></div>
  </div>;
}

function FormHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="goal-form-heading"><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></header>;
}

function GoalView({
  goal,
  busy,
  decide,
  onEditDefinition,
  onEditPlan,
  onOpenRun,
}: {
  goal: WorkspaceGoal;
  busy: boolean;
  decide: (kind: GoalDecisionKind, target?: WorkspaceGoal["definition"], approvedItemIds?: string[], reason?: string) => Promise<void>;
  onEditDefinition: () => void;
  onEditPlan: () => void;
  onOpenRun?: (runId: string) => void;
}) {
  const definition = goal.definition?.content as WorkspaceGoalDefinition | undefined;
  const plan = goal.plan?.content as WorkspaceGoalPlan | undefined;
  const approvedDecision = goal.plan ? [...goal.decisions].reverse().find((item) => item.kind === "approve_plan" && item.targetRevisionId === goal.plan?.id && item.targetHash === goal.plan.contentHash) : undefined;
  const [selectedPlanItems, setSelectedPlanItems] = useState<string[]>(approvedDecision?.approvedItemIds ?? plan?.items.map((item) => item.id) ?? []);
  useEffect(() => {
    setSelectedPlanItems(approvedDecision?.approvedItemIds ?? plan?.items.map((item) => item.id) ?? []);
  }, [goal.id, goal.plan?.id, goal.plan?.contentHash, approvedDecision?.id]);
  const evidenceByCriterion = useMemo(
    () => new Map((definition?.criteria ?? []).map((criterion) => [criterion.key, goal.evidenceLinks.filter((link) => link.criterionKey === criterion.key)])),
    [definition, goal.evidenceLinks],
  );
  const canEdit = !["completed", "cancelled"].includes(goal.status);
  const progress = goal.requiredCriteria ? Math.round(goal.verifiedCriteria / goal.requiredCriteria * 100) : 0;

  const nextActionHandler = () => {
    if (goal.nextAction.kind === "review_goal") return void decide("approve_goal");
    if (goal.nextAction.kind === "create_plan") return onEditPlan();
    if (goal.nextAction.kind === "review_plan" && goal.plan) return void decide("approve_plan", goal.plan, selectedPlanItems);
    if (goal.nextAction.kind === "resume") return void decide("resume");
    if (goal.nextAction.kind === "view_result") return goal.status === "ready_to_close" ? void decide("close") : undefined;
    if (goal.nextAction.kind === "view_running_task" && goal.currentRunId) return onOpenRun?.(goal.currentRunId);
    return undefined;
  };
  const actionable = ["review_goal", "create_plan", "review_plan", "resume", "view_result", "view_running_task"].includes(goal.nextAction.kind);

  return <article className="goal-view">
    <header className="goal-hero">
      <div className="goal-hero-meta"><StatusBadge status={goal.status} />{canEdit && <button className="goal-secondary-action" onClick={onEditDefinition} disabled={busy}><Pencil size={13} />Edit</button>}</div>
      <h2>{definition?.title ?? "Untitled Goal"}</h2>
      <p>{definition?.outcome}</p>
    </header>

    <section className="goal-next-card">
      <div className="goal-next-icon"><Target size={18} /></div>
      <div><span className="eyebrow">Next step</span><strong>{goal.nextAction.title}</strong><p>{goal.nextAction.explanation}</p>{goal.nextAction.kind === "run_task" && <small>Start the next TaskRun from Chat or Runs. Automatic successors stay off.</small>}</div>
      {actionable && <button className="memory-primary" disabled={busy || goal.nextAction.kind === "review_plan" && selectedPlanItems.length === 0} onClick={nextActionHandler}>{goal.nextAction.primaryActionLabel}</button>}
    </section>

    <section className="goal-progress-card">
      <div className="goal-section-heading"><div><span className="eyebrow">Verified progress</span><h3>Completion criteria</h3></div><strong>{goal.verifiedCriteria}/{goal.requiredCriteria}</strong></div>
      <div className="goal-progress-track" aria-label={`${progress}% of required criteria verified`}><i style={{ width: `${progress}%` }} /></div>
      <div className="goal-criteria-list">
        {definition?.criteria.map((criterion) => {
          const evidence = evidenceByCriterion.get(criterion.key) ?? [];
          const validCount = evidence.filter((link) => link.status === "valid").length;
          const contradicted = evidence.some((link) => link.status === "contradicted");
          return <div className={validCount ? "verified" : contradicted ? "warning" : "pending"} key={criterion.key}>
            {validCount ? <CheckCircle2 size={16} /> : contradicted ? <AlertTriangle size={16} /> : <Circle size={16} />}
            <span><strong>{criterion.title}</strong><small>{validCount ? `${validCount} valid evidence link${validCount === 1 ? "" : "s"}` : contradicted ? "Evidence needs attention" : criterion.required ? "Required · not verified" : "Optional"}</small></span>
          </div>;
        })}
      </div>
    </section>

    <section className="goal-section-card">
      <div className="goal-section-heading">
        <div><span className="eyebrow">Current plan</span><h3>{goal.plan ? `Plan v${goal.plan.revision}` : "No plan yet"}</h3>{plan?.summary && <p>{plan.summary}</p>}</div>
        {canEdit && goal.status !== "draft" && <button className="goal-secondary-action" onClick={onEditPlan} disabled={busy}>{goal.plan ? <Pencil size={13} /> : <Plus size={13} />}{goal.plan ? "Revise" : "Create plan"}</button>}
      </div>
      {plan && goal.plan ? <div className="goal-plan-list">
        {plan.items.map((item, index) => {
          const approved = approvedDecision?.approvedItemIds.includes(item.id) ?? false;
          const selectable = !approvedDecision;
          return <label className={approved ? "approved" : ""} key={item.id}>
            {selectable ? <input type="checkbox" checked={selectedPlanItems.includes(item.id)} disabled={busy} onChange={(event) => setSelectedPlanItems((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /> : approved ? <Check size={15} /> : <Circle size={15} />}
            <span className="goal-plan-index">{index + 1}</span>
            <span><strong>{item.title}</strong><small>{item.outcome}</small><details><summary>Verification</summary><p>{item.verification}</p></details></span>
            {approved && <em>Approved</em>}
          </label>;
        })}
        {!approvedDecision && <p className="goal-plan-help">Choose the steps covered by this approval. The primary action above approves the selected slice.</p>}
      </div> : <div className="goal-section-empty"><FileCheck2 size={19} /><p>Create a short plan after approving the Goal definition.</p></div>}
    </section>

    <details className="goal-disclosure goal-details">
      <summary><span><ChevronRight size={14} />Scope and boundaries</span><small>{(definition?.scope.length ?? 0) + (definition?.nonGoals.length ?? 0)} items</small></summary>
      <div className="goal-scope-grid">
        <InfoList title="Included" items={definition?.scope ?? []} empty="No explicit scope items." />
        <InfoList title="Not included" items={definition?.nonGoals ?? []} empty="No exclusions recorded." />
      </div>
    </details>

    <details className="goal-disclosure goal-details">
      <summary><span><ChevronRight size={14} />Linked TaskRuns</span><small>{goal.runLinks.length}</small></summary>
      {goal.runLinks.length ? <div className="goal-run-links">{goal.runLinks.map((link) => <button key={link.runId} onClick={() => onOpenRun?.(link.runId)}><code>{link.runId.slice(0, 12)}</code><span>{link.criterionKeys.length ? `${link.criterionKeys.length} criterion target${link.criterionKeys.length === 1 ? "" : "s"}` : "No criterion targets"}</span></button>)}</div> : <p className="muted">No TaskRun is linked yet.</p>}
    </details>

    {!['completed', 'cancelled'].includes(goal.status) && <details className="goal-disclosure goal-details goal-management">
      <summary><span><ChevronRight size={14} />Goal controls</span><small>Pause or cancel</small></summary>
      <div>{goal.status === "active" && <button disabled={busy} onClick={() => void decide("pause")}>Pause Goal</button>}{goal.status === "paused" && <button className="memory-primary" disabled={busy} onClick={() => void decide("resume")}>Resume Goal</button>}<button className="danger-quiet" disabled={busy} onClick={() => void decide("cancel")}>Cancel Goal</button></div>
    </details>}
  </article>;
}

function StatusBadge({ status }: { status: WorkspaceGoal["status"] }) {
  return <span className={`goal-status-badge ${statusTone(status)}`}><i />{statusLabel(status)}</span>;
}

function InfoList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return <section><h4>{title}</h4>{items.length ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="muted">{empty}</p>}</section>;
}

function lines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function nextKey(existing: string[], prefix: string): string {
  let index = existing.length + 1;
  while (existing.includes(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

function statusLabel(status: WorkspaceGoal["status"]): string {
  return ({
    draft: "Needs review",
    active: "In progress",
    paused: "Waiting",
    ready_to_close: "Ready to close",
    completed: "Completed",
    cancelled: "Cancelled",
  } as const)[status];
}

function statusTone(status: WorkspaceGoal["status"]): "attention" | "active" | "waiting" | "success" | "muted" {
  if (status === "draft" || status === "ready_to_close") return "attention";
  if (status === "active") return "active";
  if (status === "paused") return "waiting";
  if (status === "completed") return "success";
  return "muted";
}

function decisionNotice(kind: GoalDecisionKind): string {
  return ({
    approve_goal: "Goal approved. No TaskRun was started.",
    approve_plan: "Selected plan steps approved. Execution remains manual.",
    request_change: "Changes requested.",
    pause: "Goal paused.",
    resume: "Goal resumed.",
    close: "Goal closed with verified evidence.",
    cancel: "Goal cancelled.",
  } as const)[kind];
}
