import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Circle, Pencil, Plus, Target, X } from "lucide-react";
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
const blankPlan = (): WorkspaceGoalPlan => ({ summary: "", items: [{ id: "item-1", title: "", outcome: "", verification: "" }] });

type GoalDecisionKind = "approve_goal" | "approve_plan" | "request_change" | "pause" | "resume" | "close" | "cancel";
type EditorMode = "create" | "definition" | "plan" | null;

export function GoalsPanel({ workspaceId, onClose, onOpenRun }: { workspaceId: string; onClose: () => void; onOpenRun?: (runId: string) => void }) {
  const [items, setItems] = useState<WorkspaceGoalSummary[]>([]);
  const [selected, setSelected] = useState<WorkspaceGoal | null>(null);
  const [editor, setEditor] = useState<EditorMode>(null);
  const [definition, setDefinition] = useState<WorkspaceGoalDefinition>(blankDefinition);
  const [plan, setPlan] = useState<WorkspaceGoalPlan>(blankPlan);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async (selectId?: string) => {
    const nextItems = await api.workspaceGoals(workspaceId);
    setItems(nextItems);
    const targetId = selectId ?? selected?.id;
    if (targetId && nextItems.some((item) => item.id === targetId)) setSelected(await api.workspaceGoal(targetId));
  };
  useEffect(() => {
    let active = true;
    setSelected(null); setEditor(null); setError(""); setNotice("");
    void api.workspaceGoals(workspaceId).then((next) => { if (active) setItems(next); }).catch((cause) => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [workspaceId]);
  const openGoal = async (goalId: string) => {
    setBusy(true); setError(""); setNotice("");
    try { setSelected(await api.workspaceGoal(goalId)); setEditor(null); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };
  const decide = async (kind: GoalDecisionKind, target = selected?.definition, approvedItemIds: string[] = [], reason = "") => {
    if (!selected || !target || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await api.decideWorkspaceGoal(selected.id, target.id, target.contentHash, kind, approvedItemIds, reason);
      setSelected(next); setEditor(null); await refresh(next.id); setNotice(decisionNotice(kind));
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };
  const beginDefinitionEdit = () => {
    const current = selected?.definition?.content as WorkspaceGoalDefinition | undefined;
    setDefinition(current ? clone(current) : blankDefinition()); setEditor(selected ? "definition" : "create"); setError(""); setNotice("");
  };
  const beginPlanEdit = () => {
    const current = selected?.plan?.content as WorkspaceGoalPlan | undefined;
    setPlan(current ? clone(current) : blankPlan()); setEditor("plan"); setError(""); setNotice("");
  };
  return <div className="goals-lite-overlay" role="dialog" aria-modal="true" aria-labelledby="workspace-goals-title">
    <section className="goals-lite-panel">
      <header><div><small>Workspace</small><h1 id="workspace-goals-title">Goals</h1><p>Long-term outcomes, bounded plans, existing TaskRuns and durable evidence.</p></div><button className="icon-button" onClick={onClose} aria-label="Close Goals"><X size={18}/></button></header>
      <div className="goals-lite-body">
        <aside><button className="new-goal-button" onClick={() => { setSelected(null); setDefinition(blankDefinition()); setEditor("create"); setError(""); setNotice(""); }}><Plus size={15}/>New Goal</button>{items.map((goal) => <button className={selected?.id === goal.id ? "selected" : ""} key={goal.id} onClick={() => void openGoal(goal.id)} disabled={busy}><Target size={14}/><span><strong>{goal.title}</strong><small>{statusLabel(goal.status)} · {goal.verifiedCriteria}/{goal.requiredCriteria} verified</small></span></button>)}</aside>
        <main>{error && <div className="error-banner">{error}</div>}{notice && <div className="goal-notice">{notice}</div>}{editor === "create" || editor === "definition" ? <GoalDefinitionForm definition={definition} setDefinition={setDefinition} busy={busy} editing={editor === "definition"} onCancel={() => setEditor(null)} onSave={async () => {
          setBusy(true); setError(""); setNotice("");
          try {
            if (selected) { await api.reviseWorkspaceGoal(selected.id, definition); await refresh(selected.id); setNotice("A new Goal revision was saved. Review and approve the updated definition before planning."); }
            else { const goal = await api.createWorkspaceGoal(workspaceId, definition); setSelected(goal); await refresh(goal.id); setNotice("Goal draft created. No TaskRun was started."); }
            setEditor(null);
          } catch (cause) { setError(message(cause)); }
          finally { setBusy(false); }
        }}/> : editor === "plan" && selected ? <GoalPlanForm plan={plan} setPlan={setPlan} busy={busy} onCancel={() => setEditor(null)} onSave={async () => {
          setBusy(true); setError(""); setNotice("");
          try { await api.addWorkspaceGoalPlan(selected.id, plan); await refresh(selected.id); setEditor(null); setNotice("Plan revision saved. Select the items that may be executed."); }
          catch (cause) { setError(message(cause)); }
          finally { setBusy(false); }
        }}/> : selected ? <GoalView goal={selected} busy={busy} decide={decide} onEditDefinition={beginDefinitionEdit} onEditPlan={beginPlanEdit} onOpenRun={onOpenRun}/> : <div className="goals-lite-empty"><Target size={34}/><h2>Select or create a Goal</h2><p>A Goal is a lightweight Workspace-level outcome. It never starts TaskRuns automatically.</p></div>}</main>
      </div>
    </section>
  </div>;
}

function GoalDefinitionForm({ definition, setDefinition, busy, editing, onSave, onCancel }: { definition: WorkspaceGoalDefinition; setDefinition: (value: WorkspaceGoalDefinition) => void; busy: boolean; editing: boolean; onSave: () => Promise<void>; onCancel: () => void }) {
  const updateCriterion = (index: number, patch: Partial<WorkspaceGoalDefinition["criteria"][number]>) => setDefinition({ ...definition, criteria: definition.criteria.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) });
  const addCriterion = () => setDefinition({ ...definition, criteria: [...definition.criteria, { key: nextKey(definition.criteria.map((item) => item.key), "criterion"), title: "", required: true }] });
  const valid = definition.title.trim() && definition.outcome.trim() && definition.criteria.length && definition.criteria.every((item) => item.key.trim() && item.title.trim()) && new Set(definition.criteria.map((item) => item.key.trim())).size === definition.criteria.length;
  return <div className="goals-lite-form"><span className="goal-status">{editing ? "New revision" : "Draft only"}</span><h2>{editing ? "Revise the long-term outcome" : "Define the long-term outcome"}</h2><p>{editing ? "Saving creates a new immutable revision and makes earlier approvals stale." : "Creating this draft will not plan work or modify the Workspace."}</p><label><span>Title</span><input maxLength={200} value={definition.title} onChange={(event) => setDefinition({ ...definition, title: event.target.value })}/></label><label><span>Outcome</span><textarea rows={4} maxLength={4000} value={definition.outcome} onChange={(event) => setDefinition({ ...definition, outcome: event.target.value })}/></label><div className="goal-form-columns"><label><span>Scope <small>one item per line</small></span><textarea rows={4} value={definition.scope.join("\n")} onChange={(event) => setDefinition({ ...definition, scope: lines(event.target.value) })}/></label><label><span>Not included <small>one item per line</small></span><textarea rows={4} value={definition.nonGoals.join("\n")} onChange={(event) => setDefinition({ ...definition, nonGoals: lines(event.target.value) })}/></label></div><fieldset className="goal-criteria-editor"><legend>Completion criteria</legend>{definition.criteria.map((criterion, index) => <div className="goal-criterion-editor" key={`${criterion.key}:${index}`}><input aria-label={`Criterion ${index + 1} key`} value={criterion.key} onChange={(event) => updateCriterion(index, { key: event.target.value })}/><input aria-label={`Criterion ${index + 1} title`} value={criterion.title} onChange={(event) => updateCriterion(index, { title: event.target.value })}/><label className="goal-required"><input type="checkbox" checked={criterion.required} onChange={(event) => updateCriterion(index, { required: event.target.checked })}/>required</label><button type="button" disabled={definition.criteria.length === 1} onClick={() => setDefinition({ ...definition, criteria: definition.criteria.filter((_, itemIndex) => itemIndex !== index) })}>Remove</button></div>)}<button type="button" onClick={addCriterion}><Plus size={14}/>Add criterion</button></fieldset><div className="goal-form-actions"><button onClick={onCancel} disabled={busy}>Cancel</button><button className="primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? "Saving…" : editing ? "Save revision" : "Create Goal draft"}</button></div></div>;
}

function GoalPlanForm({ plan, setPlan, busy, onSave, onCancel }: { plan: WorkspaceGoalPlan; setPlan: (value: WorkspaceGoalPlan) => void; busy: boolean; onSave: () => Promise<void>; onCancel: () => void }) {
  const update = (index: number, patch: Partial<WorkspaceGoalPlanItem>) => setPlan({ ...plan, items: plan.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) });
  const add = () => setPlan({ ...plan, items: [...plan.items, { id: nextKey(plan.items.map((item) => item.id), "item"), title: "", outcome: "", verification: "" }] });
  const valid = plan.summary.trim() && plan.items.length && plan.items.every((item) => item.id.trim() && item.title.trim() && item.outcome.trim() && item.verification.trim()) && new Set(plan.items.map((item) => item.id.trim())).size === plan.items.length;
  return <div className="goals-lite-form"><span className="goal-status">Plan revision</span><h2>Prepare a bounded plan</h2><p>Saving a plan does not start a TaskRun. A separate item-level approval is still required.</p><label><span>Plan summary</span><textarea rows={3} value={plan.summary} onChange={(event) => setPlan({ ...plan, summary: event.target.value })}/></label><div className="goal-plan-editor">{plan.items.map((item, index) => <section key={`${item.id}:${index}`}><header><strong>Plan item {index + 1}</strong><button type="button" disabled={plan.items.length === 1} onClick={() => setPlan({ ...plan, items: plan.items.filter((_, itemIndex) => itemIndex !== index) })}>Remove</button></header><label><span>Item ID</span><input value={item.id} onChange={(event) => update(index, { id: event.target.value })}/></label><label><span>Title</span><input value={item.title} onChange={(event) => update(index, { title: event.target.value })}/></label><label><span>User-visible outcome</span><textarea rows={2} value={item.outcome} onChange={(event) => update(index, { outcome: event.target.value })}/></label><label><span>How it will be verified</span><textarea rows={2} value={item.verification} onChange={(event) => update(index, { verification: event.target.value })}/></label></section>)}</div><button type="button" onClick={add}><Plus size={14}/>Add plan item</button><div className="goal-form-actions"><button onClick={onCancel} disabled={busy}>Cancel</button><button className="primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? "Saving…" : "Save plan revision"}</button></div></div>;
}

function GoalView({ goal, busy, decide, onEditDefinition, onEditPlan, onOpenRun }: { goal: WorkspaceGoal; busy: boolean; decide: (kind: GoalDecisionKind, target?: WorkspaceGoal["definition"], approvedItemIds?: string[], reason?: string) => Promise<void>; onEditDefinition: () => void; onEditPlan: () => void; onOpenRun?: (runId: string) => void }) {
  const definition = goal.definition?.content as WorkspaceGoalDefinition | undefined;
  const plan = goal.plan?.content as WorkspaceGoalPlan | undefined;
  const approvedDecision = goal.plan ? [...goal.decisions].reverse().find((item) => item.kind === "approve_plan" && item.targetRevisionId === goal.plan?.id && item.targetHash === goal.plan.contentHash) : undefined;
  const [selectedPlanItems, setSelectedPlanItems] = useState<string[]>(approvedDecision?.approvedItemIds ?? plan?.items.map((item) => item.id) ?? []);
  useEffect(() => { setSelectedPlanItems(approvedDecision?.approvedItemIds ?? plan?.items.map((item) => item.id) ?? []); }, [goal.id, goal.plan?.id, goal.plan?.contentHash, approvedDecision?.id]);
  const evidenceByCriterion = useMemo(() => new Map((definition?.criteria ?? []).map((criterion) => [criterion.key, goal.evidenceLinks.filter((link) => link.criterionKey === criterion.key)])), [definition, goal.evidenceLinks]);
  const canEdit = !["completed", "cancelled"].includes(goal.status);
  const nextActionHandler = () => {
    if (goal.nextAction.kind === "review_goal") return void decide("approve_goal");
    if (goal.nextAction.kind === "create_plan") return onEditPlan();
    if (goal.nextAction.kind === "review_plan" && goal.plan) return void decide("approve_plan", goal.plan, selectedPlanItems);
    if (goal.nextAction.kind === "resume") return void decide("resume");
    if (goal.nextAction.kind === "view_result") return goal.status === "ready_to_close" ? void decide("close") : undefined;
    if (goal.nextAction.kind === "view_running_task" && goal.currentRunId) return onOpenRun?.(goal.currentRunId);
    return undefined;
  };
  return <article className="goals-lite-view"><header><div className="goal-view-heading"><span className="goal-status"><Circle size={8}/>{statusLabel(goal.status)}</span>{canEdit && <button onClick={onEditDefinition} disabled={busy}><Pencil size={13}/>Edit definition</button>}</div><h2>{definition?.title ?? "Untitled Goal"}</h2><p>{definition?.outcome}</p></header><section className="goal-next-action"><small>Next step</small><strong>{goal.nextAction.title}</strong><p>{goal.nextAction.explanation}</p>{["review_goal", "create_plan", "review_plan", "resume", "view_result", "view_running_task"].includes(goal.nextAction.kind) && <button className="primary" disabled={busy || goal.nextAction.kind === "review_plan" && selectedPlanItems.length === 0} onClick={nextActionHandler}>{goal.nextAction.primaryActionLabel}</button>}{goal.nextAction.kind === "run_task" && <small>Start the next bounded TaskRun from Chat or Runs, then link it through the Goal API. Automatic successors remain disabled.</small>}</section><section><div className="goal-section-heading"><h3>Completion criteria</h3><small>{goal.verifiedCriteria}/{goal.requiredCriteria} required criteria verified</small></div><div className="goal-lite-criteria">{definition?.criteria.map((criterion) => { const evidence = evidenceByCriterion.get(criterion.key) ?? []; const valid = evidence.some((link) => link.status === "valid"); const contradicted = evidence.some((link) => link.status === "contradicted"); return <div key={criterion.key}>{valid ? <CheckCircle2 size={16}/> : contradicted ? <AlertTriangle size={16}/> : <Circle size={16}/>}<span><strong>{criterion.title}{criterion.required ? "" : " (optional)"}</strong><small>{valid ? `${evidence.filter((link) => link.status === "valid").length} valid evidence link(s)` : contradicted ? "contradicted evidence needs resolution" : "not verified"}</small></span></div>; })}</div></section>{plan && goal.plan ? <section><div className="goal-section-heading"><div><h3>Plan v{goal.plan.revision}</h3><small>{plan.summary}</small></div>{canEdit && <button onClick={onEditPlan} disabled={busy}><Pencil size={13}/>New revision</button>}</div><div className="goal-plan-review">{plan.items.map((item) => <label key={item.id}><input type="checkbox" checked={selectedPlanItems.includes(item.id)} disabled={busy || Boolean(approvedDecision)} onChange={(event) => setSelectedPlanItems((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))}/><span><strong>{item.title}</strong><small>{item.outcome}</small><em>Verify: {item.verification}</em></span></label>)}</div>{approvedDecision ? <p className="goal-approved-note"><CheckCircle2 size={15}/>Approved slice: {approvedDecision.approvedItemIds.length} item(s). Editing the plan creates a new hash and requires a new approval.</p> : <button className="primary" disabled={busy || !selectedPlanItems.length} onClick={() => void decide("approve_plan", goal.plan, selectedPlanItems)}>Approve {selectedPlanItems.length} selected item{selectedPlanItems.length === 1 ? "" : "s"}</button>}</section> : goal.status !== "draft" && canEdit ? <section><h3>Current plan</h3><p className="muted">No plan revision exists yet. Keep it bounded: one TaskRun-sized item at a time.</p><button onClick={onEditPlan}><Plus size={14}/>Create plan</button></section> : null}<div className="goal-scope-grid">{definition?.scope.length ? <section><h3>Scope</h3><ul>{definition.scope.map((item) => <li key={item}>{item}</li>)}</ul></section> : null}{definition?.nonGoals.length ? <section><h3>Not included</h3><ul>{definition.nonGoals.map((item) => <li key={item}>{item}</li>)}</ul></section> : null}</div><section><h3>Linked TaskRuns</h3>{goal.runLinks.length ? <div className="goal-run-links">{goal.runLinks.map((link) => <button key={link.runId} onClick={() => onOpenRun?.(link.runId)}><code>{link.runId.slice(0, 12)}</code><span>{link.criterionKeys.length ? `${link.criterionKeys.length} criteria` : "No criterion targets"}</span></button>)}</div> : <p className="muted">No TaskRun is linked. Execution stays manual in this lightweight version.</p>}</section><div className="goal-lite-actions">{goal.status === "active" && <button disabled={busy} onClick={() => void decide("pause")}>Pause</button>}{goal.status === "paused" && <button className="primary" disabled={busy} onClick={() => void decide("resume")}>Resume</button>}{!['completed', 'cancelled'].includes(goal.status) && <button className="danger-quiet" disabled={busy} onClick={() => void decide("cancel")}>Cancel Goal</button>}</div></article>;
}

function lines(value: string): string[] { return value.split("\n").map((item) => item.trim()).filter(Boolean); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
function nextKey(existing: string[], prefix: string): string { let index = existing.length + 1; while (existing.includes(`${prefix}-${index}`)) index += 1; return `${prefix}-${index}`; }
function statusLabel(status: WorkspaceGoal["status"]): string { return ({ draft: "Needs review", active: "In progress", paused: "Waiting", ready_to_close: "Ready to close", completed: "Completed", cancelled: "Cancelled" } as const)[status]; }
function decisionNotice(kind: GoalDecisionKind): string { return ({ approve_goal: "Goal approved. No TaskRun was started.", approve_plan: "Selected plan items approved. Execution remains manual.", request_change: "Changes requested.", pause: "Goal paused.", resume: "Goal resumed.", close: "Goal closed with verified evidence.", cancel: "Goal cancelled." } as const)[kind]; }
