import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  ExternalLink,
  Pencil,
  Play,
  Plus,
  Target,
  Trash2,
  X,
} from "lucide-react";
import { ICON_SIZE } from "./icon-size";
import {
  api,
  type WorkspaceGoal,
  type WorkspaceGoalDefinition,
  type WorkspaceGoalRoadmap,
  type WorkspaceGoalRoadmapItem,
  type WorkspaceGoalSummary,
} from "./api";
import { formatCount } from "./count-format";
import { goalStatusTone } from "./goal-display";

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

  return <div className="memory-overlay" role="dialog" aria-modal="true" aria-labelledby="workspace-goals-title">
    <button className="memory-backdrop" onClick={onClose} aria-label="Close Goals" />
    <section className="memory-center" ref={dialogRef}>
      <header className="memory-header">
        <div>
          <Target size={ICON_SIZE.xl} />
          <h2 id="workspace-goals-title">Workspace Goals</h2>
        </div>
        <div className="memory-header-actions">
          <button className="icon-button" onClick={onClose} aria-label="Close Goals"><X size={ICON_SIZE.lg} /></button>
        </div>
      </header>

      <div className="goal-shell">
        {items.length > 0 && <div className="goal-toolbar">
          <select aria-label="Workspace Goals" value={selected?.id ?? ""} disabled={busy} onChange={(event) => void openGoal(event.target.value)}>
            {items.map((goal) => <option value={goal.id} key={goal.id}>{goal.title} · {statusLabel(goal.status)} · {goal.verifiedCriteria}/{goal.requiredCriteria}</option>)}
          </select>
          <button className="control" data-variant="primary" onClick={() => {
            setSelected(null);
            setDefinition(blankDefinition());
            setEditor("create");
            setError("");
            setNotice("");
          }}><Plus size={ICON_SIZE.md} />New Goal</button>
        </div>}

        <main className="goal-main" aria-busy={busy}>
          {error && <div className="notice" data-tone="danger" role="alert">{error}</div>}
          {notice && <div className="notice" data-tone="success" role="status">{notice}</div>}
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

function GoalEmpty({ busy, onCreate }: { busy: boolean; onCreate: () => void }) {
  return <div className="goal-empty">
    <div><Target size={ICON_SIZE.hero} /></div>
    <h2>Create a Goal</h2>
    <p>Define one outcome, then approve the steps TAgent can run toward it.</p>
    <button className="control" data-variant="primary" disabled={busy} onClick={onCreate}><Plus size={ICON_SIZE.md} />Create Goal</button>
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
    <fieldset>
      <legend>Completion criteria</legend>
      <div className="section-heading"><p data-meta>Supervisor evidence from Goal Roadmap TaskRuns is checked against these criteria.</p><button className="control" type="button" onClick={addCriterion}><Plus size={ICON_SIZE.sm} />Add criterion</button></div>
      <div className="goal-criteria-editor">
        {definition.criteria.map((criterion, index) => <div className="goal-criterion-editor" key={`${criterion.key}:${index}`}>
          <input aria-label={`Criterion ${index + 1}`} value={criterion.title} onChange={(event) => updateCriterion(index, { title: event.target.value })} placeholder="A verifiable completion condition" />
          <label><input type="checkbox" checked={criterion.required} onChange={(event) => updateCriterion(index, { required: event.target.checked })} />Required</label>
          <button className="icon-button" type="button" aria-label={`Remove criterion ${index + 1}`} disabled={definition.criteria.length === 1} onClick={() => setDefinition({ ...definition, criteria: definition.criteria.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={ICON_SIZE.sm} /></button>
        </div>)}
      </div>
      {!definition.criteria.some((item) => item.required) && <p className="goal-field-error">Keep at least one required criterion so evidence can close the Goal.</p>}
    </fieldset>
    <details open={Boolean(definition.scope.length || definition.nonGoals.length)}>
      <summary><span><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} />Scope and boundaries</span><small>Optional</small></summary>
      <div className="goal-form-columns">
        <label className="goal-field"><span>Included <small>one item per line</small></span><textarea rows={4} value={definition.scope.join("\n")} onChange={(event) => setDefinition({ ...definition, scope: lines(event.target.value) })} /></label>
        <label className="goal-field"><span>Not included <small>one item per line</small></span><textarea rows={4} value={definition.nonGoals.join("\n")} onChange={(event) => setDefinition({ ...definition, nonGoals: lines(event.target.value) })} /></label>
      </div>
    </details>
    <div className="goal-form-actions"><button className="control" onClick={onCancel} disabled={busy}>Cancel</button><button className="control" data-variant="primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? "Saving…" : editing ? "Save revision" : "Create draft"}</button></div>
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
        <header><div><span>Item {index + 1}</span><strong>{item.title.trim() || "Untitled item"}</strong></div><button className="icon-button" type="button" aria-label={`Remove Roadmap item ${index + 1}`} disabled={roadmap.items.length === 1} onClick={() => setRoadmap({ ...roadmap, items: roadmap.items.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={ICON_SIZE.sm} /></button></header>
        <label className="goal-field"><span>Title</span><input value={item.title} onChange={(event) => update(index, { title: event.target.value })} placeholder="One TaskRun-sized item" /></label>
        <label className="goal-field"><span>Expected outcome</span><textarea rows={2} value={item.outcome} onChange={(event) => update(index, { outcome: event.target.value })} /></label>
        <label className="goal-field"><span>Verification</span><textarea rows={2} value={item.verification} onChange={(event) => update(index, { verification: event.target.value })} /></label>
        <fieldset><legend>Advances Goal criteria</legend><div>{definition.criteria.map((criterion) => <label key={criterion.key}><input type="checkbox" checked={item.criterionKeys.includes(criterion.key)} onChange={(event) => update(index, { criterionKeys: event.target.checked ? [...item.criterionKeys, criterion.key] : item.criterionKeys.filter((key) => key !== criterion.key) })} /><span>{criterion.title}</span></label>)}</div></fieldset>
        {!item.criterionKeys.length && <p className="goal-field-error">Select at least one Goal criterion.</p>}
      </section>)}
    </div>
    <button className="control" type="button" onClick={add}><Plus size={ICON_SIZE.sm} />Add item</button>
    <div className="goal-form-actions"><button className="control" onClick={onCancel} disabled={busy}>Cancel</button><button className="control" data-variant="primary" disabled={busy || !valid} onClick={() => void onSave()}>{busy ? "Saving…" : "Save Roadmap"}</button></div>
  </div>;
}

function FormHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="goal-form-heading"><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></header>;
}

export function GoalView({ goal, busy, decide, onGenerateRoadmap, onStartRoadmapItem, onEditDefinition, onEditRoadmap, onOpenRun }: {
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
  const changeTargets = [
    goal.activeDefinitionRevisionId === goal.definition?.id ? goal.definition : null,
    goal.activeRoadmapRevisionId === goal.roadmap?.id ? goal.roadmap : null,
  ].filter((item): item is GoalRevision => Boolean(item));
  const defaultChangeTargetId = changeTargets.at(-1)?.id ?? "";
  const [changeTargetId, setChangeTargetId] = useState(defaultChangeTargetId);
  const [changeReason, setChangeReason] = useState("");
  useEffect(() => setSelectedItems(approval?.approvedItemIds ?? roadmap?.items.map((item) => item.id) ?? []), [goal.id, goal.roadmap?.id, goal.roadmap?.contentHash, approval?.id]);
  useEffect(() => { setChangeTargetId(defaultChangeTargetId); setChangeReason(""); }, [goal.id, defaultChangeTargetId]);
  const evidenceByCriterion = useMemo(() => new Map((definition?.criteria ?? []).map((criterion) => [criterion.key, goal.evidenceLinks.filter((link) => link.goalRevision === goal.definition?.revision && link.criterionKey === criterion.key)])), [definition, goal.definition?.revision, goal.evidenceLinks]);
  const progressByItem = useMemo(() => new Map(goal.roadmapProgress.map((item) => [item.itemId, item])), [goal.roadmapProgress]);
  const canEdit = !["completed", "cancelled"].includes(goal.status) && !goal.currentRunId;
  const verifiedPercent = goal.requiredCriteria ? Math.round(goal.verifiedCriteria / goal.requiredCriteria * 100) : 0;
  const approvedRoadmapItems = approval?.approvedItemIds.length ?? 0;
  const completedRoadmapItems = approval?.approvedItemIds.filter((itemId) => progressByItem.get(itemId)?.status === "completed").length ?? 0;
  const auditCount = goal.runLinks.length + goal.evidenceLinks.length + goal.decisions.length;

  const nextAction = () => {
    if (goal.nextAction.kind === "review_goal") return void decide("approve_goal");
    if (goal.nextAction.kind === "generate_roadmap") return void onGenerateRoadmap();
    if (goal.nextAction.kind === "review_roadmap" && goal.roadmap) {
      if (requiresRoadmapRevision) return onEditRoadmap();
      return void decide("approve_roadmap", goal.roadmap, selectedItems);
    }
    if (goal.nextAction.kind === "run_roadmap_item" && goal.nextAction.roadmapItemId) return void onStartRoadmapItem(goal.nextAction.roadmapItemId);
    if (["view_running_task", "resolve_problem"].includes(goal.nextAction.kind)) {
      const targetRunId = goal.nextAction.taskRunId ?? goal.currentRunId;
      if (targetRunId) return onOpenRun?.(targetRunId);
    }
    if (goal.nextAction.kind === "resume") return void decide("resume");
    if (goal.nextAction.kind === "view_result" && goal.status === "ready_to_close" && window.confirm("Close this Goal with the verified evidence? This cannot be undone.")) return void decide("close");
    return undefined;
  };
  const actionable = goal.nextAction.kind !== "view_result" || goal.status === "ready_to_close";
  const showsNextAction = goal.nextAction.actor !== "none" && actionable;
  const actionDisabled = busy || goal.nextAction.kind === "review_roadmap" && selectedItems.length === 0;
  const canCreateRoadmapManually = showsNextAction && canEdit && goal.nextAction.kind === "generate_roadmap";

  return <article className="goal-view">
    <header className="goal-hero">
      <div className="goal-hero-meta"><StatusBadge status={goal.status} />{canEdit && <button className="control" onClick={onEditDefinition} disabled={busy}><Pencil size={ICON_SIZE.sm} />Edit Goal</button>}</div>
      <h2>{definition?.title ?? "Untitled Goal"}</h2>
      <p>{definition?.outcome}</p>
      {goal.definition && <small data-mono>definition v{goal.definition.revision} · {dateLabel(goal.updatedAt)}{goal.currentRunId ? ` · run ${goal.currentRunId.slice(0, 12)}` : ""}</small>}
    </header>

    {showsNextAction && <section className="goal-next-card">
      <div className="goal-next-copy"><span className="eyebrow">Next action</span><strong>{goal.nextAction.title}</strong><p>{goal.nextAction.explanation}</p></div>
      <div className="goal-next-actions">
        {canCreateRoadmapManually && <button className="control" onClick={onEditRoadmap} disabled={busy}><Plus size={ICON_SIZE.sm} />Create manually</button>}
        <button className="control" data-variant="primary" disabled={actionDisabled} onClick={nextAction}>{busy ? "Working…" : goal.nextAction.primaryActionLabel}</button>
      </div>
    </section>}

    <details open={goal.nextAction.kind === "review_goal" || ["ready_to_close", "completed"].includes(goal.status)}>
      <summary><span><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} />Completion criteria</span><small>{goal.verifiedCriteria}/{goal.requiredCriteria} verified</small></summary>
      <div>
        {verifiedPercent > 0 && <div className="goal-progress-track" aria-label={`${verifiedPercent}% of required criteria verified`}><i style={{ width: `${verifiedPercent}%` }} /></div>}
        <div className="goal-criteria-list">
        {definition?.criteria.map((criterion) => {
          const evidence = evidenceByCriterion.get(criterion.key) ?? [];
          const validCount = evidence.filter((link) => link.status === "valid").length;
          const decisive = [...evidence].filter((link) => link.status !== "stale")
            .sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id)).at(-1);
          const verified = decisive?.status === "valid";
          const contradicted = decisive?.status === "contradicted";
          return <div data-tone={verified ? "success" : contradicted ? "warning" : undefined} key={criterion.key}>
            {verified ? <CheckCircle2 size={ICON_SIZE.md} /> : contradicted ? <AlertTriangle size={ICON_SIZE.md} /> : <Circle size={ICON_SIZE.md} />}
            <span><strong>{criterion.title}</strong><small>{verified ? formatCount(validCount, "verified source") : contradicted ? "Latest evidence contradicted" : criterion.required ? "Required · pending" : "Optional"}</small></span>
          </div>;
        })}
        </div>
      </div>
    </details>

    {roadmap && goal.roadmap && <details open={!approval || requiresRoadmapRevision}>
      <summary><span><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} />Roadmap v{goal.roadmap.revision}</span><small>{requiresRoadmapRevision ? "Revision required" : approval ? `${completedRoadmapItems}/${approvedRoadmapItems} complete` : "Review and approve"}</small></summary>
      <div>
        <div className="section-heading" data-label>
          <div><span className="eyebrow">Goal Roadmap</span><h3>{roadmap.summary || `Roadmap v${goal.roadmap.revision}`}</h3></div>
          {canEdit && goal.status !== "draft" && <button className="control" onClick={onEditRoadmap} disabled={busy}><Pencil size={ICON_SIZE.sm} />Edit</button>}
        </div>
        <div className="goal-roadmap-list">
        {roadmap.items.map((item, index) => {
          const approved = approval?.approvedItemIds.includes(item.id) ?? false;
          const itemProgress = progressByItem.get(item.id);
          const itemStatus = itemProgress?.status ?? (approved ? "pending" : "unapproved");
          const selectable = !approval && !requiresRoadmapRevision;
          const tone = itemStatus === "running" ? "info" : itemStatus === "completed" ? "success" : itemStatus === "blocked" ? "warning" : undefined;
          return <div className="goal-roadmap-item" key={item.id}>
            <div className="goal-roadmap-leading" data-tone={tone}>
              {selectable ? <input aria-label={`Approve ${item.title}`} type="checkbox" checked={selectedItems.includes(item.id)} disabled={busy} onChange={(event) => setSelectedItems((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /> : itemStatus === "completed" ? <CheckCircle2 size={ICON_SIZE.md} /> : itemStatus === "blocked" ? <AlertTriangle size={ICON_SIZE.md} /> : approved ? <Check size={ICON_SIZE.md} /> : <Circle size={ICON_SIZE.md} />}
              <span>{index + 1}</span>
            </div>
            <div className="goal-roadmap-copy"><strong>{item.title}</strong><p>{item.outcome}</p><div>{item.criterionKeys.map((key) => <span key={key}>{definition?.criteria.find((criterion) => criterion.key === key)?.title ?? key}</span>)}</div><details><summary>Verification</summary><p>{item.verification}</p></details></div>
            <div className="goal-roadmap-action"><em>{roadmapStatusLabel(itemStatus)}</em>{approved && (itemStatus === "pending" || itemStatus === "blocked" && itemProgress?.retryable && !goal.currentRunId) && <button className="control" disabled={busy || Boolean(goal.currentRunId)} onClick={() => void onStartRoadmapItem(item.id)}><Play size={ICON_SIZE.xs} />{itemStatus === "blocked" ? "Retry" : "Start"}</button>}{itemProgress?.runId && ["running", "blocked"].includes(itemStatus) && <button className="control" onClick={() => onOpenRun?.(itemProgress.runId!)}><ExternalLink size={ICON_SIZE.xs} />Open</button>}</div>
          </div>;
        })}
        {!approval && <p data-meta>{requiresRoadmapRevision ? "Changes were requested. Edit and save a new Roadmap revision before approval." : "Select the items that may drive TaskRuns, then approve the Roadmap above."}</p>}
        </div>
      </div>
    </details>}

    {definition && definition.scope.length + definition.nonGoals.length > 0 && <details>
      <summary><span><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} />Scope and boundaries</span><small>{formatCount(definition.scope.length + definition.nonGoals.length, "item")}</small></summary>
      <div className="goal-scope-grid"><InfoList title="Included" items={definition.scope} /><InfoList title="Not included" items={definition.nonGoals} /></div>
    </details>}

    {auditCount > 0 && <details>
      <summary><span><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} />Activity and audit</span><small>{formatCount(auditCount, "entry", "entries")}</small></summary>
      <div>
        {goal.runLinks.length > 0 && <section><div className="section-heading"><strong>Linked TaskRuns</strong><small>{goal.runLinks.length} linked</small></div><div className="goal-run-links">{[...goal.runLinks].reverse().map((link) => <button key={link.runId} onClick={() => onOpenRun?.(link.runId)}><code>{link.runId.slice(0, 12)}</code><span>{runLinkLabel(link)}</span></button>)}</div></section>}
        {goal.evidenceLinks.length > 0 && <section><div className="section-heading"><strong>Evidence log</strong><small>{formatCount(goal.evidenceLinks.length, "link")}</small></div><div className="goal-run-links">{[...goal.evidenceLinks].reverse().map((link) => <button key={link.id} onClick={() => onOpenRun?.(link.runId)}><code>{link.criterionKey}</code><span>{statusLabelForValue(link.status)} · run {link.runId.slice(0, 12)}{link.artifactId ? ` · artifact ${link.artifactId.slice(0, 10)}` : ""}</span></button>)}</div></section>}
        {goal.decisions.length > 0 && <section><div className="section-heading"><strong>Decision history</strong><small>{formatCount(goal.decisions.length, "decision")}</small></div><div className="goal-run-links">{[...goal.decisions].reverse().map((decision) => <div key={decision.id}><code>{decisionLabel(decision.kind)}</code><span>{decision.reason ? `${decision.reason} · ` : ""}{decision.actorId} · {dateLabel(decision.createdAt)}</span></div>)}</div></section>}
      </div>
    </details>}

    {!['completed', 'cancelled'].includes(goal.status) && <details className="goal-management">
      <summary><span><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} />Goal controls</span><small>Lifecycle and revision</small></summary>
      <div>
        <div className="memory-inline-actions">{["active", "ready_to_close"].includes(goal.status) && <button className="control" disabled={busy || Boolean(goal.currentRunId)} onClick={() => void decide("pause")}>Pause Goal</button>}{goal.status === "paused" && <button className="control" data-variant="primary" disabled={busy} onClick={() => void decide("resume")}>Resume Goal</button>}{goal.status === "ready_to_close" && <button className="control" data-variant="primary" disabled={busy} onClick={() => { if (window.confirm("Close this Goal with the verified evidence? This cannot be undone.")) void decide("close"); }}>Close Goal</button>}<button className="control" data-tone="danger" disabled={busy || Boolean(goal.currentRunId)} onClick={() => { if (window.confirm("Cancel this Goal? This cannot be undone.")) void decide("cancel"); }}>Cancel Goal</button></div>
        {changeTargets.length > 0 && <div className="goal-form-columns">
          {changeTargets.length > 1 && <label className="goal-field"><span>Revision to reopen</span><select value={changeTargetId} onChange={(event) => setChangeTargetId(event.target.value)}>{changeTargets.map((target) => <option value={target.id} key={target.id}>{target.kind === "definition" ? "Goal definition" : "Roadmap"} v{target.revision}</option>)}</select></label>}
          <label className="goal-field"><span>Request a revision <small>reason required</small></span><textarea rows={3} value={changeReason} onChange={(event) => setChangeReason(event.target.value)} placeholder="What needs to change before this revision can guide work?" /></label>
          <div className="memory-inline-actions"><button className="control" disabled={busy || Boolean(goal.currentRunId) || !changeReason.trim()} onClick={() => { const target = changeTargets.find((item) => item.id === changeTargetId); if (target) void decide("request_change", target, [], changeReason.trim()); }}>Request changes</button></div>
        </div>}
      </div>
    </details>}
  </article>;
}

function StatusBadge({ status }: { status: WorkspaceGoal["status"] }) {
  return <span className="status-label" data-tone={goalStatusTone(status)}><i className="status-dot" />{statusLabel(status)}</span>;
}

function InfoList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return <section><h4>{title}</h4><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></section>;
}

function lines(value: string): string[] { return value.split("\n").map((item) => item.trim()).filter(Boolean); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
function nextKey(existing: string[], prefix: string): string { let index = existing.length + 1; while (existing.includes(`${prefix}_${index}`)) index += 1; return `${prefix}_${index}`; }

function statusLabel(status: WorkspaceGoal["status"]): string {
  return ({ draft: "Needs review", active: "In progress", paused: "Paused", ready_to_close: "Ready to close", completed: "Completed", cancelled: "Cancelled" } as const)[status];
}

function roadmapStatusLabel(status: WorkspaceGoal["roadmapProgress"][number]["status"]): string {
  return ({ unapproved: "Not approved", pending: "Ready", running: "Running", completed: "Done", blocked: "Needs attention", skipped: "Skipped" } as const)[status];
}

function runLinkLabel(link: WorkspaceGoal["runLinks"][number]): string {
  if (link.mode !== "roadmap") return "Workspace Goal guidance";
  return link.roadmapItemIds.length > 0 ? formatCount(link.roadmapItemIds.length, "Roadmap item") : "Roadmap guidance";
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

function decisionLabel(kind: WorkspaceGoal["decisions"][number]["kind"]): string {
  return ({ approve_goal: "Goal approved", approve_roadmap: "Roadmap approved", request_change: "Changes requested", pause: "Paused", resume: "Resumed", close: "Closed", cancel: "Cancelled" } as const)[kind];
}

function statusLabelForValue(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

function dateLabel(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value);
}
