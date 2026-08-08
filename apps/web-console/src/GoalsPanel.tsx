import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  ExternalLink,
  Map as MapIcon,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Target,
  Trash2,
  X,
} from "lucide-react";
import {
  api,
  type WorkspaceGoal,
  type WorkspaceGoalDefinition,
  type WorkspaceGoalRoadmap,
  type WorkspaceGoalRoadmapItem,
  type WorkspaceGoalSummary,
} from "./api";

const blankDefinition = (): WorkspaceGoalDefinition => ({
  title: "",
  outcome: "",
  scope: [],
  nonGoals: [],
  criteria: [{ key: "criterion_1", title: "", required: true }],
  completionPolicy: "user_confirm",
});

function blankRoadmap(definition?: WorkspaceGoalDefinition): WorkspaceGoalRoadmap {
  return {
    summary: "",
    items: [newRoadmapItem([], definition)],
  };
}

function newRoadmapItem(existing: string[], definition?: WorkspaceGoalDefinition): WorkspaceGoalRoadmapItem {
  return {
    id: nextKey(existing, "item"),
    title: "",
    outcome: "",
    verification: "",
    criterionKeys: definition?.criteria[0] ? [definition.criteria[0].key] : [],
  };
}

type GoalDecisionKind = "approve_goal" | "approve_roadmap" | "request_change" | "pause" | "resume" | "close" | "cancel";
type GoalRevision = NonNullable<WorkspaceGoal["definition"]>;
type EditorMode = "create" | "definition" | "roadmap" | null;

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
  const [roadmap, setRoadmap] = useState<WorkspaceGoalRoadmap>(() => blankRoadmap());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const refresh = async (selectId?: string) => {
    const nextItems = await api.workspaceGoals(workspaceId);
    setItems(nextItems);
    const targetId = selectId ?? selected?.id ?? nextItems[0]?.id;
    if (targetId && nextItems.some((item) => item.id === targetId)) setSelected(await api.workspaceGoal(targetId));
    else setSelected(null);
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

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),summary,[href],[tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
    const frame = requestAnimationFrame(() => focusable()[0]?.focus());
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (!elements.length) return event.preventDefault();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKey);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

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
    target: GoalRevision | null = selected?.definition ?? null,
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

  const generateRoadmap = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await api.generateWorkspaceGoalRoadmap(selected.id);
      setSelected(next);
      await refresh(next.id);
      setNotice("Roadmap draft generated. Review and edit it before approval.");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const startRoadmapItem = async (roadmapItemId: string) => {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.startWorkspaceGoalRoadmapItem(selected.id, roadmapItemId);
      setSelected(result.goal);
      await refresh(selected.id);
      if (result.runId) onOpenRun?.(result.runId);
      else setNotice("Roadmap item queued. It will start after the active TaskRun finishes.");
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

  const beginRoadmapEdit = () => {
    const currentDefinition = selected?.definition?.content as WorkspaceGoalDefinition | undefined;
    const current = selected?.roadmap?.content as WorkspaceGoalRoadmap | undefined;
    setRoadmap(current ? clone(current) : blankRoadmap(currentDefinition));
    setEditor("roadmap");
    setError("");
    setNotice("");
  };

  return <div className="memory-overlay goal-overlay" role="dialog" aria-modal="true" aria-labelledby="workspace-goals-title">
    <button className="memory-backdrop" onClick={onClose} aria-label="Close Goals" />
    <section className="memory-center goal-center" ref={dialogRef}>
      <header className="memory-header goal-header">
        <div className="memory-heading-icon"><Target size={21} /></div>
        <div>
          <span className="eyebrow">Workspace direction</span>
          <h2 id="workspace-goals-title">Goals</h2>
          <p>Approve the outcome and Roadmap, then run one bounded item at a time.</p>
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

        <main className="goal-main" aria-busy={busy}>
          {error && <div className="memory-alert error goal-alert" role="alert">{error}</div>}
          {notice && <div className="memory-alert success goal-alert" role="status">{notice}</div>}
          {busy && !selected && editor === null ? <GoalLoading /> : editor === "create" || editor === "definition" ? <GoalDefinitionForm
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
                  setNotice("Definition updated. Approve the new revision before generating a Roadmap.");
                } else {
                  const goal = await api.createWorkspaceGoal(workspaceId, definition);
                  setSelected(goal);
                  await refresh(goal.id);
                  setNotice("Goal draft created.");
                }
                setEditor(null);
              } catch (cause) {
                setError(message(cause));
              } finally {
                setBusy(false);
              }
            }}
          /> : editor === "roadmap" && selected ? <GoalRoadmapForm
            roadmap={roadmap}
            setRoadmap={setRoadmap}
            definition={selected.definition?.content as WorkspaceGoalDefinition}
            busy={busy}
            onCancel={() => setEditor(null)}
            onSave={async () => {
              setBusy(true);
              setError("");
              setNotice("");
              try {
                const next = await api.addWorkspaceGoalRoadmap(selected.id, roadmap);
                setSelected(next);
                await refresh(selected.id);
                setEditor(null);
                setNotice("Roadmap saved. Select the items to approve.");
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
            onGenerateRoadmap={generateRoadmap}
            onStartRoadmapItem={startRoadmapItem}
            onEditDefinition={beginDefinitionEdit}
            onEditRoadmap={beginRoadmapEdit}
            onOpenRun={onOpenRun}
          /> : <GoalEmpty busy={busy} onCreate={beginDefinitionEdit} />}
        </main>
      </div>
    </section>
  </div>;
}

function GoalNavigation({ items, selectedId, busy, onOpen }: {
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

  if (!items.length) return <div className="goal-sidebar-empty"><Target size={18} /><p>No Goals yet.</p><small>Create one for work that spans several TaskRuns.</small></div>;
  return <nav className="goal-nav" aria-label="Workspace Goals">
    {groups.map((group) => <section key={group.label}>
      <h3>{group.label}<span>{group.items.length}</span></h3>
      {group.items.map((goal) => {
        const progress = goal.requiredCriteria ? Math.round(goal.verifiedCriteria / goal.requiredCriteria * 100) : 0;
        return <button type="button" className={selectedId === goal.id ? "selected" : ""} key={goal.id} onClick={() => void onOpen(goal.id)} disabled={busy}>
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
    <span className="eyebrow">Long-term direction</span>
    <h2>Create a Workspace Goal</h2>
    <p>The Goal guides every TaskRun in this Workspace; Roadmap items provide approved, TaskRun-sized steps.</p>
    <button className="memory-primary" disabled={busy} onClick={onCreate}><Plus size={15} />Create Goal</button>
  </div>;
}

function GoalLoading() {
  return <div className="goal-loading" role="status" aria-label="Loading Workspace Goals">
    <span /><span /><span />
  </div>;
}

function GoalDefinitionForm({ definition, setDefinition, busy, editing, onSave, onCancel }: {
  definition: WorkspaceGoalDefinition;
  setDefinition: (value: WorkspaceGoalDefinition) => void;
  busy: boolean;
  editing: boolean;
  onSave: () => Promise<void>;
  onCancel: () => void;
}) {
  const updateCriterion = (index: number, patch: Partial<WorkspaceGoalDefinition["criteria"][number]>) => setDefinition({
    ...definition,
    criteria: definition.criteria.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
  });
  const addCriterion = () => setDefinition({
    ...definition,
    criteria: [...definition.criteria, { key: nextKey(definition.criteria.map((item) => item.key), "criterion"), title: "", required: true }],
  });
  const valid = Boolean(definition.title.trim() && definition.outcome.trim() && definition.criteria.length
    && definition.criteria.every((item) => item.key.trim() && item.title.trim())
    && definition.criteria.some((item) => item.required)
    && new Set(definition.criteria.map((item) => item.key.trim())).size === definition.criteria.length);

  return <div className="goal-form">
    <FormHeading eyebrow={editing ? "Definition revision" : "New Goal"} title={editing ? "Update the outcome" : "What should this Workspace achieve?"} description={editing ? "A new definition must be approved before it can guide TaskRuns." : "Describe the outcome and the evidence required to close it."} />
    <label className="goal-field"><span>Title</span><input autoFocus maxLength={200} value={definition.title} onChange={(event) => setDefinition({ ...definition, title: event.target.value })} placeholder="A short, outcome-focused name" /></label>
    <label className="goal-field"><span>Outcome</span><textarea rows={4} maxLength={4000} value={definition.outcome} onChange={(event) => setDefinition({ ...definition, outcome: event.target.value })} placeholder="Describe the Workspace state you want to reach" /></label>
    <fieldset className="goal-editor-section">
      <legend>Completion criteria</legend>
      <p>Supervisor evidence from Goal Roadmap TaskRuns will be checked against these criteria.</p>
      <div className="goal-criteria-editor">
        {definition.criteria.map((criterion, index) => <div className="goal-criterion-editor" key={`${criterion.key}:${index}`}>
          <span>{index + 1}</span>
          <input aria-label={`Criterion ${index + 1}`} value={criterion.title} onChange={(event) => updateCriterion(index, { title: event.target.value })} placeholder="A verifiable completion condition" />
          <label className="goal-required"><input type="checkbox" checked={criterion.required} onChange={(event) => updateCriterion(index, { required: event.target.checked })} />Required</label>
          <button className="goal-icon-action" type="button" aria-label={`Remove criterion ${index + 1}`} disabled={definition.criteria.length === 1} onClick={() => setDefinition({ ...definition, criteria: definition.criteria.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={14} /></button>
        </div>)}
      </div>
      {!definition.criteria.some((item) => item.required) && <p className="goal-field-error">Keep at least one required criterion so evidence can close the Goal.</p>}
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

function GoalRoadmapForm({ roadmap, setRoadmap, definition, busy, onSave, onCancel }: {
  roadmap: WorkspaceGoalRoadmap;
  setRoadmap: (value: WorkspaceGoalRoadmap) => void;
  definition: WorkspaceGoalDefinition;
  busy: boolean;
  onSave: () => Promise<void>;
  onCancel: () => void;
}) {
  const update = (index: number, patch: Partial<WorkspaceGoalRoadmapItem>) => setRoadmap({
    ...roadmap,
    items: roadmap.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
  });
  const add = () => setRoadmap({
    ...roadmap,
    items: [...roadmap.items, newRoadmapItem(roadmap.items.map((item) => item.id), definition)],
  });
  const valid = Boolean(roadmap.summary.trim() && roadmap.items.length
    && roadmap.items.every((item) => item.id.trim() && item.title.trim() && item.outcome.trim() && item.verification.trim() && item.criterionKeys.length)
    && new Set(roadmap.items.map((item) => item.id.trim())).size === roadmap.items.length);

  return <div className="goal-form">
    <FormHeading eyebrow="Goal Roadmap" title="Review the TaskRun-sized steps" description="Edit the LLM draft, map each item to Goal criteria, then save it for approval." />
    <label className="goal-field"><span>Roadmap summary</span><textarea autoFocus rows={3} value={roadmap.summary} onChange={(event) => setRoadmap({ ...roadmap, summary: event.target.value })} /></label>
    <div className="goal-roadmap-editor">
      {roadmap.items.map((item, index) => <section key={`${item.id}:${index}`}>
        <header><div><span>Item {index + 1}</span><strong>{item.title.trim() || "Untitled item"}</strong></div><button className="goal-icon-action" type="button" aria-label={`Remove Roadmap item ${index + 1}`} disabled={roadmap.items.length === 1} onClick={() => setRoadmap({ ...roadmap, items: roadmap.items.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={14} /></button></header>
        <label className="goal-field"><span>Title</span><input value={item.title} onChange={(event) => update(index, { title: event.target.value })} placeholder="One TaskRun-sized item" /></label>
        <label className="goal-field"><span>Expected outcome</span><textarea rows={2} value={item.outcome} onChange={(event) => update(index, { outcome: event.target.value })} /></label>
        <label className="goal-field"><span>Verification</span><textarea rows={2} value={item.verification} onChange={(event) => update(index, { verification: event.target.value })} /></label>
        <fieldset className="goal-criterion-links"><legend>Advances Goal criteria</legend><div>{definition.criteria.map((criterion) => <label key={criterion.key}><input type="checkbox" checked={item.criterionKeys.includes(criterion.key)} onChange={(event) => update(index, { criterionKeys: event.target.checked ? [...item.criterionKeys, criterion.key] : item.criterionKeys.filter((key) => key !== criterion.key) })} /><span>{criterion.title}</span></label>)}</div></fieldset>
        {!item.criterionKeys.length && <p className="goal-field-error">Select at least one Goal criterion.</p>}
      </section>)}
    </div>
    <button className="goal-secondary-action" type="button" onClick={add}><Plus size={14} />Add item</button>
    <div className="goal-form-actions"><button onClick={onCancel} disabled={busy}>Cancel</button><button className="memory-primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? "Saving…" : "Save Roadmap"}</button></div>
  </div>;
}

function FormHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="goal-form-heading"><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></header>;
}

function GoalView({ goal, busy, decide, onGenerateRoadmap, onStartRoadmapItem, onEditDefinition, onEditRoadmap, onOpenRun }: {
  goal: WorkspaceGoal;
  busy: boolean;
  decide: (kind: GoalDecisionKind, target?: GoalRevision | null, approvedItemIds?: string[], reason?: string) => Promise<void>;
  onGenerateRoadmap: () => Promise<void>;
  onStartRoadmapItem: (itemId: string) => Promise<void>;
  onEditDefinition: () => void;
  onEditRoadmap: () => void;
  onOpenRun?: (runId: string) => void;
}) {
  const definition = goal.definition?.content as WorkspaceGoalDefinition | undefined;
  const roadmap = goal.roadmap?.content as WorkspaceGoalRoadmap | undefined;
  const matchingApproval = goal.roadmap ? [...goal.decisions].reverse().find((item) => item.kind === "approve_roadmap" && item.targetRevisionId === goal.roadmap?.id && item.targetHash === goal.roadmap.contentHash) : undefined;
  const approval = goal.activeRoadmapRevisionId === goal.roadmap?.id ? matchingApproval : undefined;
  const requiresRoadmapRevision = Boolean(matchingApproval && !approval);
  const [selectedItems, setSelectedItems] = useState<string[]>(approval?.approvedItemIds ?? roadmap?.items.map((item) => item.id) ?? []);
  useEffect(() => setSelectedItems(approval?.approvedItemIds ?? roadmap?.items.map((item) => item.id) ?? []), [goal.id, goal.roadmap?.id, goal.roadmap?.contentHash, approval?.id]);
  const evidenceByCriterion = useMemo(() => new Map((definition?.criteria ?? []).map((criterion) => [criterion.key, goal.evidenceLinks.filter((link) => link.goalRevision === goal.definition?.revision && link.criterionKey === criterion.key)])), [definition, goal.definition?.revision, goal.evidenceLinks]);
  const progressByItem = useMemo(() => new Map(goal.roadmapProgress.map((item) => [item.itemId, item])), [goal.roadmapProgress]);
  const canEdit = !["completed", "cancelled"].includes(goal.status) && !goal.currentRunId;
  const verifiedPercent = goal.requiredCriteria ? Math.round(goal.verifiedCriteria / goal.requiredCriteria * 100) : 0;

  const nextAction = () => {
    if (goal.nextAction.kind === "review_goal") return void decide("approve_goal");
    if (goal.nextAction.kind === "generate_roadmap") return void onGenerateRoadmap();
    if (goal.nextAction.kind === "review_roadmap" && goal.roadmap) {
      if (requiresRoadmapRevision) return onEditRoadmap();
      return void decide("approve_roadmap", goal.roadmap, selectedItems);
    }
    if (goal.nextAction.kind === "run_roadmap_item" && goal.nextAction.roadmapItemId) return void onStartRoadmapItem(goal.nextAction.roadmapItemId);
    if (["view_running_task", "resolve_problem"].includes(goal.nextAction.kind) && goal.currentRunId) return onOpenRun?.(goal.currentRunId);
    if (goal.nextAction.kind === "resume") return void decide("resume");
    if (goal.nextAction.kind === "view_result" && goal.status === "ready_to_close" && window.confirm("Close this Goal with the verified evidence? This cannot be undone.")) return void decide("close");
    return undefined;
  };
  const actionable = goal.nextAction.kind !== "view_result" || goal.status === "ready_to_close";
  const actionDisabled = busy || goal.nextAction.kind === "review_roadmap" && selectedItems.length === 0 || goal.nextAction.actor === "none";

  return <article className="goal-view">
    <header className="goal-hero">
      <div className="goal-hero-meta"><StatusBadge status={goal.status} />{canEdit && <button className="goal-secondary-action" onClick={onEditDefinition} disabled={busy}><Pencil size={13} />Edit Goal</button>}</div>
      <h2>{definition?.title ?? "Untitled Goal"}</h2>
      <p>{definition?.outcome}</p>
    </header>

    <section className="goal-next-card">
      <div className="goal-next-icon">{goal.nextAction.kind === "generate_roadmap" ? <Sparkles size={18} /> : goal.nextAction.kind === "run_roadmap_item" ? <Play size={18} /> : <Target size={18} />}</div>
      <div><span className="eyebrow">Next action</span><strong>{goal.nextAction.title}</strong><p>{goal.nextAction.explanation}</p></div>
      {actionable && <button className="memory-primary" disabled={actionDisabled} onClick={nextAction}>{busy ? "Working…" : goal.nextAction.primaryActionLabel}</button>}
    </section>

    <section className="goal-progress-card">
      <div className="goal-section-heading"><div><span className="eyebrow">Verified evidence</span><h3>Completion criteria</h3></div><strong>{goal.verifiedCriteria}/{goal.requiredCriteria}</strong></div>
      <div className="goal-progress-track" aria-label={`${verifiedPercent}% of required criteria verified`}><i style={{ width: `${verifiedPercent}%` }} /></div>
      <div className="goal-criteria-list">
        {definition?.criteria.map((criterion) => {
          const evidence = evidenceByCriterion.get(criterion.key) ?? [];
          const validCount = evidence.filter((link) => link.status === "valid").length;
          const contradicted = evidence.some((link) => link.status === "contradicted");
          return <div className={validCount && !contradicted ? "verified" : contradicted ? "warning" : "pending"} key={criterion.key}>
            {validCount && !contradicted ? <CheckCircle2 size={16} /> : contradicted ? <AlertTriangle size={16} /> : <Circle size={16} />}
            <span><strong>{criterion.title}</strong><small>{validCount && !contradicted ? `${validCount} verified source${validCount === 1 ? "" : "s"}` : contradicted ? "Evidence contradicted" : criterion.required ? "Required · pending" : "Optional"}</small></span>
          </div>;
        })}
      </div>
    </section>

    <section className="goal-section-card">
      <div className="goal-section-heading">
        <div><span className="eyebrow">Goal Roadmap</span><h3>{goal.roadmap ? `Roadmap v${goal.roadmap.revision}` : "No Roadmap yet"}</h3>{roadmap?.summary && <p>{roadmap.summary}</p>}</div>
        {canEdit && goal.status !== "draft" && <button className="goal-secondary-action" onClick={onEditRoadmap} disabled={busy}>{goal.roadmap ? <Pencil size={13} /> : <Plus size={13} />}{goal.roadmap ? "Edit" : "Create manually"}</button>}
      </div>
      {roadmap && goal.roadmap ? <div className="goal-roadmap-list">
        {roadmap.items.map((item, index) => {
          const approved = approval?.approvedItemIds.includes(item.id) ?? false;
          const itemProgress = progressByItem.get(item.id);
          const itemStatus = itemProgress?.status ?? (approved ? "pending" : "unapproved");
          const selectable = !approval && !requiresRoadmapRevision;
          return <div className={`goal-roadmap-item ${itemStatus}`} key={item.id}>
            <div className="goal-roadmap-leading">
              {selectable ? <input aria-label={`Approve ${item.title}`} type="checkbox" checked={selectedItems.includes(item.id)} disabled={busy} onChange={(event) => setSelectedItems((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /> : itemStatus === "completed" ? <CheckCircle2 size={16} /> : itemStatus === "blocked" ? <AlertTriangle size={16} /> : approved ? <Check size={16} /> : <Circle size={16} />}
              <span className="goal-roadmap-index">{index + 1}</span>
            </div>
            <div className="goal-roadmap-copy"><strong>{item.title}</strong><p>{item.outcome}</p><div>{item.criterionKeys.map((key) => <span key={key}>{definition?.criteria.find((criterion) => criterion.key === key)?.title ?? key}</span>)}</div><details><summary>Verification</summary><p>{item.verification}</p></details></div>
            <div className="goal-roadmap-action"><em>{roadmapStatusLabel(itemStatus)}</em>{approved && (itemStatus === "pending" || itemStatus === "blocked" && !goal.currentRunId) && <button className="goal-secondary-action" disabled={busy || Boolean(goal.currentRunId)} onClick={() => void onStartRoadmapItem(item.id)}><Play size={12} />{itemStatus === "blocked" ? "Retry" : "Start"}</button>}{itemProgress?.runId && ["running", "blocked"].includes(itemStatus) && <button className="goal-secondary-action" onClick={() => onOpenRun?.(itemProgress.runId!)}><ExternalLink size={12} />Open</button>}</div>
          </div>;
        })}
        {!approval && <p className="goal-roadmap-help">{requiresRoadmapRevision ? "Changes were requested. Edit and save a new Roadmap revision before approval." : "Select the items that may drive TaskRuns, then approve the Roadmap above."}</p>}
      </div> : <div className="goal-section-empty"><MapIcon size={19} /><p>Approve the Goal, then generate its initial Roadmap.</p></div>}
    </section>

    <details className="goal-disclosure goal-details">
      <summary><span><ChevronRight size={14} />Scope and boundaries</span><small>{(definition?.scope.length ?? 0) + (definition?.nonGoals.length ?? 0)} items</small></summary>
      <div className="goal-scope-grid"><InfoList title="Included" items={definition?.scope ?? []} empty="No explicit scope items." /><InfoList title="Not included" items={definition?.nonGoals ?? []} empty="No exclusions recorded." /></div>
    </details>

    <details className="goal-disclosure goal-details">
      <summary><span><ChevronRight size={14} />Linked TaskRuns</span><small>{goal.runLinks.length}</small></summary>
      {goal.runLinks.length ? <div className="goal-run-links">{[...goal.runLinks].reverse().map((link) => <button key={link.runId} onClick={() => onOpenRun?.(link.runId)}><code>{link.runId.slice(0, 12)}</code><span>{link.mode === "roadmap" ? `${link.roadmapItemIds.length} Roadmap item` : "Workspace Goal guidance"}</span></button>)}</div> : <p className="muted">No TaskRun is linked yet.</p>}
    </details>

    {!['completed', 'cancelled'].includes(goal.status) && <details className="goal-disclosure goal-details goal-management">
      <summary><span><ChevronRight size={14} />Goal controls</span><small>Pause or cancel</small></summary>
      <div>{goal.status === "active" && <button disabled={busy || Boolean(goal.currentRunId)} onClick={() => void decide("pause")}>Pause Goal</button>}{goal.status === "paused" && <button className="memory-primary" disabled={busy} onClick={() => void decide("resume")}>Resume Goal</button>}<button className="danger-quiet" disabled={busy || Boolean(goal.currentRunId)} onClick={() => { if (window.confirm("Cancel this Goal? This cannot be undone.")) void decide("cancel"); }}>Cancel Goal</button></div>
    </details>}
  </article>;
}

function StatusBadge({ status }: { status: WorkspaceGoal["status"] }) {
  return <span className={`goal-status-badge ${statusTone(status)}`}><i />{statusLabel(status)}</span>;
}

function InfoList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return <section><h4>{title}</h4>{items.length ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="muted">{empty}</p>}</section>;
}

function lines(value: string): string[] { return value.split("\n").map((item) => item.trim()).filter(Boolean); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
function nextKey(existing: string[], prefix: string): string { let index = existing.length + 1; while (existing.includes(`${prefix}_${index}`)) index += 1; return `${prefix}_${index}`; }

function statusLabel(status: WorkspaceGoal["status"]): string {
  return ({ draft: "Needs review", active: "In progress", paused: "Paused", ready_to_close: "Ready to close", completed: "Completed", cancelled: "Cancelled" } as const)[status];
}

function statusTone(status: WorkspaceGoal["status"]): "attention" | "active" | "waiting" | "success" | "muted" {
  if (status === "draft" || status === "ready_to_close") return "attention";
  if (status === "active") return "active";
  if (status === "paused") return "waiting";
  if (status === "completed") return "success";
  return "muted";
}

function roadmapStatusLabel(status: WorkspaceGoal["roadmapProgress"][number]["status"]): string {
  return ({ unapproved: "Not approved", pending: "Ready", running: "Running", completed: "Done", blocked: "Needs attention", skipped: "Skipped" } as const)[status];
}

function decisionNotice(kind: GoalDecisionKind): string {
  return ({
    approve_goal: "Goal approved. Generate the initial Roadmap when ready.",
    approve_roadmap: "Roadmap approved. Its selected items can now start TaskRuns.",
    request_change: "Changes requested.",
    pause: "Goal paused.",
    resume: "Goal resumed.",
    close: "Goal closed with verified evidence.",
    cancel: "Goal cancelled.",
  } as const)[kind];
}
