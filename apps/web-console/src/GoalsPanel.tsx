import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
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
import { createRequestId } from "./id";
import {
  api,
  type WorkspaceGoal,
  type WorkspaceGoalDefinition,
  type WorkspaceGoalOperationReceipt,
  type WorkspaceGoalRoadmap,
  type WorkspaceGoalRoadmapItem,
  type WorkspaceGoalSummary,
} from "./api";
import { formatCount } from "./count-format";
import { goalStatusTone } from "./goal-display";
import { PanelTabs, type PanelTab } from "./PanelTabs";
import { useModalFocus } from "./use-modal-focus";
import { storedStringRecord, storeStringRecord } from "./workspace-preferences";

const goalOperationRequestsKey = "tagent.goal-operation-requests";

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
type GoalSection = "overview" | "roadmap" | "activity" | "controls";

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
  const [lastOperationRequestId, setLastOperationRequestId] = useState("");
  const [busy, setBusy] = useState(true);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useModalFocus(true, dialogRef, onClose, closeRef);

  const rememberOperationRequest = (goalId: string, requestId: string) => {
    setLastOperationRequestId(requestId);
    storeStringRecord(goalOperationRequestsKey, {
      ...storedStringRecord(goalOperationRequestsKey),
      [goalId]: requestId,
    });
  };

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
    setLastOperationRequestId("");
    setBusy(true);
    void api.workspaceGoals(workspaceId)
      .then(async (next) => {
        if (!active) return;
        setItems(next);
        if (next[0]) {
          const first = await api.workspaceGoal(next[0].id);
          if (active) {
            setSelected(first);
            setLastOperationRequestId(storedStringRecord(goalOperationRequestsKey)[first.id] ?? "");
          }
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
      setLastOperationRequestId(storedStringRecord(goalOperationRequestsKey)[goalId] ?? "");
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
    const requestId = createRequestId();
    rememberOperationRequest(selected.id, requestId);
    try {
      const next = await api.generateWorkspaceGoalRoadmap(selected.id, requestId);
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

  const content = <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal-workspace" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="workspace-goals-title">
      <header className="modal-workspace-header">
        <div className="modal-heading">
          <Target size={ICON_SIZE.xl} />
          <div className="modal-title-group"><h2 className="truncate" id="workspace-goals-title">Workspace Goals</h2></div>
        </div>
        <div className="modal-workspace-actions">
          <button ref={closeRef} className="icon-button" onClick={onClose} aria-label="Close Goals"><X size={ICON_SIZE.lg} /></button>
        </div>
      </header>

      <div className="goal-shell">
        {items.length > 0 && <div className="goal-toolbar">
          <select aria-label="Workspace Goals" value={editor === "create" ? "" : selected?.id ?? ""} disabled={busy} onChange={(event) => void openGoal(event.target.value)}>
            {editor === "create" && <option value="">New Goal draft</option>}
            {items.map((goal) => <option value={goal.id} key={goal.id}>{goal.title} · {statusLabel(goal.status)} · {goal.verifiedCriteria}/{goal.requiredCriteria}</option>)}
          </select>
          {editor === null && <button className="control" data-variant="primary" onClick={() => {
            setDefinition(blankDefinition());
            setEditor("create");
            setError("");
            setNotice("");
          }}><Plus size={ICON_SIZE.md} />New Goal</button>}
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
                if (editor === "definition" && selected) {
                  const requestId = createRequestId();
                  rememberOperationRequest(selected.id, requestId);
                  await api.reviseWorkspaceGoal(selected.id, definition, requestId);
                  await refresh(selected.id);
                  setNotice("Definition updated. Approve the new revision before generating a Roadmap.");
                } else {
                  setLastOperationRequestId("");
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
                const requestId = createRequestId();
                rememberOperationRequest(selected.id, requestId);
                const next = await api.addWorkspaceGoalRoadmap(selected.id, roadmap, requestId);
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
            latestOperationRequestId={lastOperationRequestId}
          /> : <GoalEmpty busy={busy} onCreate={beginDefinitionEdit} />}
        </main>
      </div>
    </section>
  </div>;
  return typeof document === "undefined" ? content : createPortal(content, document.body);
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
    <label className="form-field"><span>Title</span><input autoFocus maxLength={200} value={definition.title} onChange={(event) => setDefinition({ ...definition, title: event.target.value })} placeholder="A short, outcome-focused name" /></label>
    <label className="form-field"><span>Outcome</span><textarea rows={4} maxLength={4000} value={definition.outcome} onChange={(event) => setDefinition({ ...definition, outcome: event.target.value })} placeholder="Describe the Workspace state you want to reach" /></label>
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
      <div className="form-columns">
        <label className="form-field"><span>Included <small>one item per line</small></span><textarea rows={4} value={definition.scope.join("\n")} onChange={(event) => setDefinition({ ...definition, scope: lines(event.target.value) })} /></label>
        <label className="form-field"><span>Not included <small>one item per line</small></span><textarea rows={4} value={definition.nonGoals.join("\n")} onChange={(event) => setDefinition({ ...definition, nonGoals: lines(event.target.value) })} /></label>
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
    <label className="form-field"><span>Roadmap summary</span><textarea autoFocus rows={3} value={roadmap.summary} onChange={(event) => setRoadmap({ ...roadmap, summary: event.target.value })} /></label>
    <div className="goal-roadmap-editor">
      {roadmap.items.map((item, index) => <section key={`${item.id}:${index}`}>
        <header><div><span>Item {index + 1}</span><strong>{item.title.trim() || "Untitled item"}</strong></div><button className="icon-button" type="button" aria-label={`Remove Roadmap item ${index + 1}`} disabled={roadmap.items.length === 1} onClick={() => setRoadmap({ ...roadmap, items: roadmap.items.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={ICON_SIZE.sm} /></button></header>
        <label className="form-field"><span>Title</span><input value={item.title} onChange={(event) => update(index, { title: event.target.value })} placeholder="One TaskRun-sized item" /></label>
        <label className="form-field"><span>Expected outcome</span><textarea rows={2} value={item.outcome} onChange={(event) => update(index, { outcome: event.target.value })} /></label>
        <label className="form-field"><span>Verification</span><textarea rows={2} value={item.verification} onChange={(event) => update(index, { verification: event.target.value })} /></label>
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

export function GoalView({ goal, busy, decide, onGenerateRoadmap, onStartRoadmapItem, onEditDefinition, onEditRoadmap, onOpenRun, latestOperationRequestId = "" }: {
  goal: WorkspaceGoal;
  busy: boolean;
  decide: (kind: GoalDecisionKind, target?: GoalRevision | null, approvedItemIds?: string[], reason?: string) => Promise<void>;
  onGenerateRoadmap: () => Promise<void>;
  onStartRoadmapItem: (itemId: string) => Promise<void>;
  onEditDefinition: () => void;
  onEditRoadmap: () => void;
  onOpenRun?: (runId: string) => void;
  latestOperationRequestId?: string;
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
  const [operationRequestId, setOperationRequestId] = useState(latestOperationRequestId);
  const [operationReceipt, setOperationReceipt] = useState<WorkspaceGoalOperationReceipt | null>(null);
  const [operationError, setOperationError] = useState("");
  const [operationBusy, setOperationBusy] = useState(false);
  const [section, setSection] = useState<GoalSection>(() => goalSectionForAction(goal.nextAction.kind));
  useEffect(() => setSelectedItems(approval?.approvedItemIds ?? roadmap?.items.map((item) => item.id) ?? []), [goal.id, goal.roadmap?.id, goal.roadmap?.contentHash, approval?.id]);
  useEffect(() => { setChangeTargetId(defaultChangeTargetId); setChangeReason(""); }, [goal.id, defaultChangeTargetId]);
  useEffect(() => { setOperationRequestId(latestOperationRequestId); setOperationReceipt(null); setOperationError(""); }, [goal.id, latestOperationRequestId]);
  useEffect(() => setSection(goalSectionForAction(goal.nextAction.kind)), [goal.id, goal.nextAction.kind]);
  const evidenceByCriterion = useMemo(() => new Map((definition?.criteria ?? []).map((criterion) => [criterion.key, goal.evidenceLinks.filter((link) => link.goalRevision === goal.definition?.revision && link.criterionKey === criterion.key)])), [definition, goal.definition?.revision, goal.evidenceLinks]);
  const progressByItem = useMemo(() => new Map(goal.roadmapProgress.map((item) => [item.itemId, item])), [goal.roadmapProgress]);
  const hasActiveRoadmapWork = goal.roadmapProgress.some((item) => item.status === "running");
  const hasQueuedRoadmapWork = goal.roadmapProgress.some((item) => Boolean(item.queueStatus));
  const lifecycleLocked = Boolean(goal.currentRunId) || hasActiveRoadmapWork || hasQueuedRoadmapWork;
  const canEdit = !["completed", "cancelled"].includes(goal.status) && !lifecycleLocked;
  const verifiedPercent = goal.requiredCriteria ? Math.round(goal.verifiedCriteria / goal.requiredCriteria * 100) : 0;
  const approvedRoadmapItems = approval?.approvedItemIds.length ?? 0;
  const completedRoadmapItems = approval?.approvedItemIds.filter((itemId) => progressByItem.get(itemId)?.status === "completed").length ?? 0;
  const auditCount = goal.runLinks.length + goal.evidenceLinks.length + goal.decisions.length;
  const tabs = [
    { value: "overview", label: "Overview", meta: `${goal.verifiedCriteria}/${goal.requiredCriteria}` },
    { value: "roadmap", label: "Roadmap", meta: goal.roadmap ? `${completedRoadmapItems}/${approvedRoadmapItems || roadmap?.items.length || 0}` : "—" },
    { value: "activity", label: "Activity", meta: String(auditCount) },
    { value: "controls", label: "Controls" },
  ] satisfies readonly PanelTab<GoalSection>[];
  const nextRoadmapItem = goal.nextAction.kind === "run_roadmap_item"
    ? roadmap?.items.find((item) => item.id === goal.nextAction.roadmapItemId)
    : undefined;
  const nextRoadmapProgress = nextRoadmapItem ? progressByItem.get(nextRoadmapItem.id) : undefined;
  const nextRoadmapQueued = Boolean(nextRoadmapProgress?.queueStatus);

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
  const actionDisabled = busy || nextRoadmapQueued || goal.nextAction.kind === "review_roadmap" && selectedItems.length === 0;
  const canCreateRoadmapManually = showsNextAction && canEdit && goal.nextAction.kind === "generate_roadmap";
  const recoverOperation = async () => {
    const requestId = operationRequestId.trim();
    if (!requestId || operationBusy) return;
    setOperationBusy(true);
    setOperationError("");
    setOperationReceipt(null);
    try {
      setOperationReceipt(await api.workspaceGoalOperation(goal.id, requestId));
    } catch (cause) {
      setOperationError(message(cause));
    } finally {
      setOperationBusy(false);
    }
  };

  return <article className="goal-view">
    <header className="goal-hero">
      <div className="goal-hero-meta inline-actions"><StatusBadge status={goal.status} />{canEdit && <button className="control" onClick={onEditDefinition} disabled={busy}><Pencil size={ICON_SIZE.sm} />Edit Goal</button>}</div>
      <h2>{definition?.title ?? "Untitled Goal"}</h2>
      <p>{definition?.outcome}</p>
      {goal.definition && <small data-mono>definition v{goal.definition.revision} · {dateLabel(goal.updatedAt)}{goal.currentRunId ? ` · run ${goal.currentRunId.slice(0, 12)}` : ""}</small>}
    </header>

    {showsNextAction && <section className="goal-next-card">
      <div className="goal-next-copy"><span className="eyebrow">{nextRoadmapQueued ? "Queued" : "Next action"}</span><strong>{nextRoadmapItem?.title ?? goal.nextAction.title}</strong><small>{nextRoadmapQueued ? "Waiting in the Supervisor queue; TAgent will attach the TaskRun when execution capacity is available." : nextRoadmapItem?.outcome ?? goal.nextAction.explanation}</small></div>
      <div className="goal-next-actions">
        {canCreateRoadmapManually && <button className="control" onClick={onEditRoadmap} disabled={busy}><Plus size={ICON_SIZE.sm} />Create manually</button>}
        <button className="control" data-variant="primary" disabled={actionDisabled} onClick={nextAction}>{nextRoadmapQueued ? "Queued" : busy ? "Working…" : goal.nextAction.primaryActionLabel}</button>
      </div>
    </section>}

    <PanelTabs label="Goal views" value={section} tabs={tabs} onChange={setSection} />

    <section hidden={section !== "overview"} aria-label="Goal overview">
      <div className="section-heading"><strong>Completion criteria</strong><small>{goal.verifiedCriteria}/{goal.requiredCriteria} verified</small></div>
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
    </section>

    {definition && definition.scope.length + definition.nonGoals.length > 0 && <section hidden={section !== "overview"} aria-label="Goal scope and boundaries">
      <div className="section-heading"><strong>Scope and boundaries</strong><small>{formatCount(definition.scope.length + definition.nonGoals.length, "item")}</small></div>
      <div className="goal-scope-grid"><InfoList title="Included" items={definition.scope} /><InfoList title="Not included" items={definition.nonGoals} /></div>
    </section>}

    <section hidden={section !== "roadmap"} aria-label="Goal Roadmap">
      {roadmap && goal.roadmap ? <>
        <div className="section-heading">
          <div><span className="eyebrow">Roadmap v{goal.roadmap.revision}</span><h3>{roadmap.summary || `Roadmap v${goal.roadmap.revision}`}</h3><small>{requiresRoadmapRevision ? "Revision required" : approval ? `${completedRoadmapItems}/${approvedRoadmapItems} complete` : "Review and approve"}</small></div>
          {canEdit && goal.status !== "draft" && <button className="control" onClick={onEditRoadmap} disabled={busy}><Pencil size={ICON_SIZE.sm} />Edit</button>}
        </div>
        <div className="goal-roadmap-list">
        {roadmap.items.map((item, index) => {
          const approved = approval?.approvedItemIds.includes(item.id) ?? false;
          const itemProgress = progressByItem.get(item.id);
          const queued = Boolean(itemProgress?.queueStatus);
          const itemStatus = queued ? "queued" as const : itemProgress?.status ?? (approved ? "pending" : "unapproved");
          const selectable = !approval && !requiresRoadmapRevision;
          const criterionTitles = item.criterionKeys.map((key) => definition?.criteria.find((criterion) => criterion.key === key)?.title ?? key);
          const tone = itemStatus === "running" ? "info" : itemStatus === "completed" ? "success" : itemStatus === "blocked" || itemStatus === "queued" ? "warning" : undefined;
          return <div className="goal-roadmap-item" key={item.id}>
            <div className="status-label" data-tone={tone}>
              {selectable ? <input aria-label={`Approve ${item.title}`} type="checkbox" checked={selectedItems.includes(item.id)} disabled={busy} onChange={(event) => setSelectedItems((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /> : itemStatus === "completed" ? <CheckCircle2 size={ICON_SIZE.md} /> : itemStatus === "blocked" ? <AlertTriangle size={ICON_SIZE.md} /> : <Circle size={ICON_SIZE.md} />}
              <span>{index + 1}</span>
            </div>
            <div className="goal-roadmap-copy">
              <strong>{item.title}</strong>
              <p>{item.outcome}</p>
              {!approval && <small>Criteria · {criterionTitles.join(" · ")}</small>}
              <details className="detail-disclosure">
                <summary><strong>{approval ? "Criteria and verification" : "Verification"}</strong>{approval && <small>{formatCount(criterionTitles.length, "criterion", "criteria")} mapped</small>}<ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
                <div className="detail-disclosure-body">
                  {approval && <section><strong>Criteria</strong><p>{criterionTitles.join(" · ")}</p></section>}
                  <section><strong>Verification</strong><p>{item.verification}</p></section>
                </div>
              </details>
            </div>
            <div className="goal-roadmap-action inline-actions"><span className="status-label" data-tone={tone}><i className="status-dot" />{roadmapStatusLabel(itemStatus)}</span>{approved && (itemStatus === "pending" || itemStatus === "blocked" && itemProgress?.retryable && !goal.currentRunId) && <button className="control" disabled={busy || Boolean(goal.currentRunId)} onClick={() => void onStartRoadmapItem(item.id)}><Play size={ICON_SIZE.xs} />{itemStatus === "blocked" ? "Retry" : "Start"}</button>}{itemProgress?.runId && ["running", "blocked"].includes(itemStatus) && <button className="control" onClick={() => onOpenRun?.(itemProgress.runId!)}><ExternalLink size={ICON_SIZE.xs} />Open</button>}</div>
          </div>;
        })}
        {!approval && <p data-meta>{requiresRoadmapRevision ? "Changes were requested. Edit and save a new Roadmap revision before approval." : "Select the items that may drive TaskRuns, then approve them with the primary action above."}</p>}
        </div>
      </> : <div className="panel-empty"><Target size={ICON_SIZE.xl} /><strong>No Roadmap yet</strong><p>Generate a bounded Roadmap or create one manually after the Goal definition is approved.</p>{canCreateRoadmapManually && <button className="control" onClick={onEditRoadmap} disabled={busy}><Plus size={ICON_SIZE.sm} />Create manually</button>}</div>}
    </section>

    <section hidden={section !== "activity"} aria-label="Goal activity and audit">
      {auditCount === 0 ? <div className="panel-empty"><Target size={ICON_SIZE.xl} /><strong>No activity yet</strong><p>TaskRuns, evidence and Goal decisions will appear here without crowding the current plan.</p></div> : <>
        {goal.runLinks.length > 0 && <section><div className="section-heading"><strong>Linked TaskRuns</strong><small>{goal.runLinks.length} linked</small></div><div className="goal-run-links">{[...goal.runLinks].reverse().map((link) => <button key={link.runId} onClick={() => onOpenRun?.(link.runId)}><code>{link.runId.slice(0, 12)}</code><span>{runLinkLabel(link)}</span></button>)}</div></section>}
        {goal.evidenceLinks.length > 0 && <section><div className="section-heading"><strong>Evidence log</strong><small>{formatCount(goal.evidenceLinks.length, "link")}</small></div><div className="goal-run-links">{[...goal.evidenceLinks].reverse().map((link) => <button key={link.id} onClick={() => onOpenRun?.(link.runId)}><code>{link.criterionKey}</code><span>{statusLabelForValue(link.status)} · run {link.runId.slice(0, 12)}{link.artifactId ? ` · artifact ${link.artifactId.slice(0, 10)}` : ""}</span></button>)}</div></section>}
        {goal.decisions.length > 0 && <section><div className="section-heading"><strong>Decision history</strong><small>{formatCount(goal.decisions.length, "decision")}</small></div><div className="goal-run-links">{[...goal.decisions].reverse().map((decision) => <div key={decision.id}><code>{decisionLabel(decision.kind)}</code><span>{decision.reason ? `${decision.reason} · ` : ""}{decision.actorId} · {dateLabel(decision.createdAt)}</span></div>)}</div></section>}
      </>}
    </section>

    <section hidden={section !== "controls"} aria-label="Goal controls">
      {['completed', 'cancelled'].includes(goal.status) ? <p data-meta>This Goal is terminal. Its definition, Roadmap and audit history remain available in the other views.</p> : <>
        <div className="section-heading"><strong>Lifecycle</strong><small>{statusLabel(goal.status)}</small></div>
        {hasQueuedRoadmapWork ? <p data-meta>Wait for the queued Roadmap work to attach its TaskRun before revising or changing this Goal's lifecycle.</p> : lifecycleLocked && <p data-meta>Finish or resolve the active Roadmap work before revising or changing this Goal's lifecycle.</p>}
        <div className="inline-actions">{["active", "ready_to_close"].includes(goal.status) && <button className="control" disabled={busy || lifecycleLocked} onClick={() => void decide("pause")}>Pause Goal</button>}{goal.status === "paused" && <button className="control" data-variant="primary" disabled={busy} onClick={() => void decide("resume")}>Resume Goal</button>}{goal.status === "ready_to_close" && <button className="control" data-variant="primary" disabled={busy} onClick={() => { if (window.confirm("Close this Goal with the verified evidence? This cannot be undone.")) void decide("close"); }}>Close Goal</button>}<button className="control" data-tone="danger" disabled={busy || lifecycleLocked} onClick={() => { if (window.confirm("Cancel this Goal? This cannot be undone.")) void decide("cancel"); }}>Cancel Goal</button></div>
        {changeTargets.length > 0 && <div className="goal-control-group">
          <div className="section-heading"><strong>Revision request</strong><small>Reopen approved guidance</small></div>
          <div className="form-columns">
            {changeTargets.length > 1 && <label className="form-field"><span>Target</span><select value={changeTargetId} onChange={(event) => setChangeTargetId(event.target.value)}>{changeTargets.map((target) => <option value={target.id} key={target.id}>{target.kind === "definition" ? "Goal definition" : "Roadmap"} v{target.revision}</option>)}</select></label>}
            <label className="form-field"><span>Reason <small>required</small></span><textarea rows={3} value={changeReason} onChange={(event) => setChangeReason(event.target.value)} placeholder="What must change before this revision can guide work?" /></label>
            <div className="inline-actions"><button className="control" disabled={busy || lifecycleLocked || !changeReason.trim()} onClick={() => { const target = changeTargets.find((item) => item.id === changeTargetId); if (target) void decide("request_change", target, [], changeReason.trim()); }}>Request changes</button></div>
          </div>
        </div>}
      </>}
    </section>

    <section hidden={section !== "controls"} aria-label="Goal operation recovery">
      <div className="section-heading"><strong>Operation recovery</strong><small>{latestOperationRequestId ? `Last request ${latestOperationRequestId.slice(0, 12)}…` : "Receipt by request ID"}</small></div>
      <div className="form-columns">
        <label className="form-field"><span>Request ID <small>definition, Roadmap, or generation</small></span><input maxLength={300} value={operationRequestId} onChange={(event) => setOperationRequestId(event.target.value)} placeholder="Paste the original request ID" /></label>
        <div><span className="eyebrow">Durable receipt</span><p data-meta>Inspect an interrupted or uncertain Goal operation without repeating it.</p><button className="control" disabled={operationBusy || !operationRequestId.trim()} onClick={() => void recoverOperation()}>{operationBusy ? "Looking up…" : "Inspect receipt"}</button></div>
      </div>
      {operationError && <p className="goal-field-error" role="alert">{operationError}</p>}
      {operationReceipt && <>
        <div className="goal-run-links">
          <div><code>{statusLabelForValue(operationReceipt.state)}</code><span>{statusLabelForValue(operationReceipt.operationType)} · updated {dateLabel(operationReceipt.updatedAt)}</span></div>
          <div><code>{operationReceipt.requestId}</code><span data-mono>payload {operationReceipt.payloadHash}</span></div>
        </div>
        <details className="audit-disclosure">
          <summary><span>Payload and outcome</span><small>Raw receipt</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
          <div className="tool-call-body"><pre>{JSON.stringify({ payload: operationReceipt.payload, result: operationReceipt.result, error: operationReceipt.error, createdAt: operationReceipt.createdAt, completedAt: operationReceipt.completedAt }, null, 2)}</pre></div>
        </details>
      </>}
    </section>
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

function goalSectionForAction(kind: WorkspaceGoal["nextAction"]["kind"]): GoalSection {
  return ["generate_roadmap", "review_roadmap", "run_roadmap_item", "view_running_task", "resolve_problem"].includes(kind)
    ? "roadmap"
    : "overview";
}

function statusLabel(status: WorkspaceGoal["status"]): string {
  return ({ draft: "Needs review", active: "In progress", paused: "Paused", ready_to_close: "Ready to close", completed: "Completed", cancelled: "Cancelled" } as const)[status];
}

function roadmapStatusLabel(status: WorkspaceGoal["roadmapProgress"][number]["status"] | "queued"): string {
  return ({ unapproved: "Not approved", pending: "Ready", queued: "Queued", running: "Running", completed: "Done", blocked: "Needs attention", skipped: "Skipped" } as const)[status];
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
  return value.replaceAll("_", " ").replaceAll(".", " ").replace(/^./, (character) => character.toUpperCase());
}

function dateLabel(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value);
}
