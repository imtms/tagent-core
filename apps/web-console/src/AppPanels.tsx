import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  Activity, Bot, BrainCircuit, Check, ChevronDown, ChevronRight, Circle, Download, Eye,
  FileText, GripVertical, HelpCircle, Pencil, Send, ShieldAlert, ShieldCheck, Terminal, X,
} from "lucide-react";
import { ICON_SIZE } from "./icon-size";
import {
  api,
  type Artifact,
  type ArtifactContent,
  type ContextManifest,
  type RunEvent,
  type Session,
  type SessionInboxItem,
  type TaskRun,
  type TranscriptItem,
  type UserInputRequest,
} from "./api";
import { Markdown } from "./LazyMarkdown";
import { LiveText } from "./LiveText";
import { formatCount } from "./count-format";
import { deriveCurrentOperation } from "./current-operation";
import { formatRunStatus, formatRunValue, isActiveRunStatus, isRedundantRunPhase, runStatusNotice, runStatusTone } from "./run-state";
import { formatConversationDay, formatTime } from "./time-format";
import { LatestRequestAuthority } from "./latest-request";
import { groupExecutionItems, type ExecutionGroup } from "./transcript-projection";
import { userInputValuesForRequest } from "./user-input-state";

export function TAgentMark({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M5 6.5h14M12 6.5V18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="5" cy="6.5" r="2" fill="currentColor" />
    <circle cx="19" cy="6.5" r="2" fill="currentColor" />
    <circle cx="12" cy="18" r="2" fill="currentColor" />
  </svg>;
}

export function ConversationDateDivider({ value }: { value: number }) {
  const label = formatConversationDay(value);
  return <div className="conversation-date-divider" role="separator" aria-label={label}><span>{label}</span></div>;
}

export function WorkspaceRunStatus({ workspace }: { workspace: Session }) {
  const status = workspace.latestRunStatus;
  if (!status) return null;
  const statusText = formatRunStatus(status);
  return <span className="status-label" data-tone={runStatusTone(status)} title={`${statusText}${workspace.latestRunPhase && !isRedundantRunPhase(status, workspace.latestRunPhase) ? ` · ${formatRunValue(workspace.latestRunPhase)}` : ""}`}>
    {status === "running" ? <Activity size={ICON_SIZE.micro} /> : <span className="status-dot" />}
    <span>{statusText}</span>
  </span>;
}

function ToolCall({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  return <details className="tool-call" data-tone={item.isError ? "danger" : undefined}>
    <summary><Terminal size={ICON_SIZE.sm} /><span>{item.toolName}</span><small>{formatRunValue(item.isError ? "failed" : item.status)}</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
    <div className="tool-call-body"><div><strong>Arguments</strong><pre>{JSON.stringify(item.arguments, null, 2)}</pre></div><div><strong>Result</strong><pre>{item.result || "No result recorded"}</pre></div></div>
  </details>;
}

function ExecutionGroupView({ group, ordinal }: { group: ExecutionGroup; ordinal: number }) {
  const anchor = group.reasoning ?? group.tools[0] ?? group.output;
  if (!anchor) return null;
  const meta = [group.tools.length ? formatCount(group.tools.length, "tool call") : "", `attempt ${anchor.attempt}`, formatTime(anchor.createdAt)].filter(Boolean).join(" · ");
  const tools = group.tools.length > 0 && <div className="tool-stack" aria-label={`Stage ${ordinal} tool calls`}>{group.tools.map((item) => <ToolCall key={`${item.seq}-${item.index}`} item={item} />)}</div>;
  const output = group.output && <div className="run-step-content"><span data-label>Model output</span><Markdown>{group.output.text}</Markdown></div>;
  if (group.reasoning) return <details className="run-step" open={!group.reasoning.redacted}>
    <summary><BrainCircuit size={ICON_SIZE.sm} /><strong>{group.reasoning.redacted ? "Reasoning unavailable" : `Reasoning ${ordinal}`}</strong><small>{meta}</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
    <div className="run-step-content"><Markdown>{group.reasoning.text}</Markdown></div>
    {tools}{output}
  </details>;
  return <article className="run-step">
    <div className="run-step-meta">{group.tools.length ? <Terminal size={ICON_SIZE.sm} /> : <Bot size={ICON_SIZE.sm} />}<strong>{group.tools.length ? `Execution ${ordinal}` : "Model output"}</strong><small>{meta}</small></div>
    {tools}{output}
  </article>;
}

export function UserInputCard({ request, submitting, onSubmit }: { request: UserInputRequest; submitting: boolean; onSubmit: (values: Record<string, string>) => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>(() => userInputValuesForRequest(request));
  const missing = request.fields.some((field) => field.required && !values[field.key]?.trim());
  return <section className="user-input-card" aria-label="TaskRun needs more information">
    <div className="user-input-heading"><HelpCircle size={ICON_SIZE.lg} /><div><strong>Information needed to continue</strong><p>{request.prompt}</p></div><span>Paused</span></div>
    <p>This form only supplies requested information. It does not approve or authorize an external action.</p>
    <ul>{request.fields.map((field) => <li key={field.key}><strong>{field.label}{field.required ? " *" : ""}</strong>{field.description && <span>{field.description}</span>}</li>)}</ul>
    <form onSubmit={(event) => { event.preventDefault(); if (!missing && !submitting) void onSubmit(userInputValuesForRequest(request, values)); }}>
      {request.fields.map((field) => <label key={field.key}><span>{field.label}{field.required ? " *" : ""}</span>{field.inputType === "textarea" ? <textarea rows={3} value={values[field.key] ?? ""} placeholder={field.placeholder} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} /> : <input value={values[field.key] ?? ""} placeholder={field.placeholder} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} />}{field.description && <small>{field.description}</small>}</label>)}
      <button type="submit" disabled={missing || submitting}>{submitting ? <Activity className="spin" size={ICON_SIZE.md} /> : <Send size={ICON_SIZE.md} />}{submitting ? "Resuming…" : "Submit and resume"}</button>
    </form>
  </section>;
}

export function ExecutionTimeline({ runId, isRunning, items, events, liveThinking, liveOutput }: { runId: string; isRunning: boolean; items: TranscriptItem[]; events: RunEvent[]; liveThinking: string; liveOutput: string }) {
  const [expanded, setExpanded] = useState(isRunning);
  const bodyRef = useRef<HTMLDivElement>(null);
  const visible = items.filter((item) => item.kind !== "user");
  const groups = groupExecutionItems(visible);
  const completedToolIds = new Set(items.filter((item): item is Extract<TranscriptItem, { kind: "tool" }> => item.kind === "tool").map((item) => item.toolCallId));
  const liveTools = events.filter((event) => event.type.startsWith("tool.") && !completedToolIds.has(String(event.data.toolCallId ?? ""))).reduce<RunEvent[]>((latest, event) => {
    const id = String(event.data.toolCallId ?? event.seq);
    const existing = latest.findIndex((item) => String(item.data.toolCallId ?? item.seq) === id);
    if (existing >= 0) latest[existing] = event; else latest.push(event);
    return latest;
  }, []);
  useEffect(() => { setExpanded(isRunning); }, [runId, isRunning]);
  useEffect(() => {
    if (!isRunning || !expanded) return;
    const frame = requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (body) body.scrollTop = body.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, isRunning, visible.length, liveTools.length, liveThinking, liveOutput, events]);
  if (!visible.length && !liveThinking && !liveOutput && !liveTools.length) return null;
  const hasLiveStage = Boolean(liveThinking || liveOutput || liveTools.length);
  const stageCount = groups.length + Number(hasLiveStage);
  return <section className="execution-timeline" aria-label="Agent execution timeline">
    <button className="execution-timeline-heading" type="button" aria-expanded={expanded} aria-controls={`execution-trace-${runId}`} onClick={() => setExpanded((current) => !current)}>
      <span>{expanded ? <ChevronDown size={ICON_SIZE.sm} /> : <ChevronRight size={ICON_SIZE.sm} />}<Activity size={ICON_SIZE.sm} />Execution trace{isRunning && <i><span className="pulse" />Live</i>}</span>
      <small>{formatCount(stageCount, "stage")}{!isRunning && !expanded ? " · expand to inspect" : ""}</small>
    </button>
    {expanded && <div className="execution-timeline-body" id={`execution-trace-${runId}`} ref={bodyRef}>
      {groups.map((group, index) => <ExecutionGroupView key={group.key} group={group} ordinal={index + 1} />)}
      {hasLiveStage && <article className="run-step"><div className="run-step-meta"><Activity size={ICON_SIZE.sm} /><strong>Current stage</strong><span className="live-label"><span className="pulse" />Live</span></div>{liveThinking && <div className="run-step-content"><span data-label>Reasoning</span><LiveText>{liveThinking}</LiveText></div>}{liveTools.length > 0 && <div className="tool-stack">{liveTools.map((event) => <div className="tool-row" data-tone={event.data.isError ? "danger" : undefined} key={`${event.seq}-${event.type}`}><Terminal size={ICON_SIZE.sm} /><strong>{String(event.data.toolName ?? "tool")}</strong><small>{formatRunValue(event.type === "tool.started" ? "running" : event.data.isError ? "failed" : "completed")}</small></div>)}</div>}{liveOutput && <div className="run-step-content"><span data-label>Model output</span><LiveText>{liveOutput}</LiveText></div>}</article>}
    </div>}
  </section>;
}

function ToolActivityPanel({ transcriptItems, events }: { transcriptItems: Extract<TranscriptItem, { kind: "tool" }>[]; events: RunEvent[] }) {
  const latestByTool = new Map<string, RunEvent>();
  for (const event of events) {
    if (!event.type.startsWith("tool.")) continue;
    latestByTool.set(String(event.data.toolCallId ?? event.data.toolName ?? event.seq), event);
  }
  const live = [...latestByTool.values()].slice(-8).reverse();
  if (!live.length && !transcriptItems.length) return null;
  const running = live.filter((event) => event.type === "tool.started").length;
  const failed = transcriptItems.filter((item) => item.isError).length;
  const activitySummary = running > 0
    ? `${running} running`
    : transcriptItems.length > 0
      ? formatCount(transcriptItems.length, "call")
      : formatCount(live.length, "recent event");
  return <section className="audit-section">
    <div className="section-heading"><span>Tool activity</span><small>{activitySummary}{failed ? ` · ${failed} failed` : ""}</small></div>
    {live.length > 0 && <details className="audit-disclosure"><summary><Activity size={ICON_SIZE.sm} /><span>Live and recent activity</span><small>{live.length}</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary><div className="tool-stack">{live.map((event) => <div className="tool-row" key={`${event.seq}-${event.type}`}><Terminal size={ICON_SIZE.sm} /><span>{String(event.data.toolName ?? "tool")}</span><small>{formatRunValue(event.type === "tool.started" ? "running" : event.data.isError ? "failed" : "done")}</small></div>)}</div></details>}
    {transcriptItems.length > 0 && <details className="audit-disclosure"><summary><Terminal size={ICON_SIZE.sm} /><span>Recorded tool calls</span><small>{transcriptItems.length}</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary><div className="tool-history-list">{transcriptItems.map((item) => <ToolCall key={`${item.seq}-${item.index}`} item={item} />)}</div></details>}
  </section>;
}

function GateFailureRow({ failure, label }: {
  failure: { key: string; reason: string };
  label: string;
}) {
  const formattedLabel = formatRunValue(label);
  const formattedKey = formatRunValue(failure.key);
  const repeatedKey = formattedKey.toLocaleLowerCase() === formattedLabel.toLocaleLowerCase();
  return <div className="gate-detail">
    <span>{formattedLabel}</span>
    {!repeatedKey && formattedKey && <strong>{formattedKey}</strong>}
    <p>{failure.reason}</p>
  </div>;
}

function GateAuditPanel({ run }: { run: TaskRun }) {
  const gateProfile = run.contract?.executionPolicy?.gateProfile ?? "strict";
  if (gateProfile === "off") return <section className="audit-section">
    <div className="section-heading"><span>Gate audit</span><small>Direct delivery</small></div>
    <p data-meta>This TaskRun skips completion acceptance. Safety approvals and tool policies still apply.</p>
  </section>;
  const gates = run.supervision.latestGates;
  if (!gates.length && !isActiveRunStatus(run.status)) return null;
  const failedGates = gates.filter((gate) => !gate.passed && gate.failures.length > 0);
  const settledCompletion = gates.find((gate) => gate.gateType === "completion");
  const completionPassed = settledCompletion?.passed ?? run.completionGate.passed;
  const completionFailures = settledCompletion?.failures ?? run.completionGate.failures.map((failure) => ({ ...failure, disposition: "auto_fixable" }));
  const passedGates = gates.filter((gate) => gate.passed).length;
  const failedGateCount = gates.filter((gate) => !gate.passed && gate.failures.length > 0).length;
  const deferredGates = gates.length - passedGates - failedGateCount;
  const evaluationSummary = [
    passedGates > 0 ? `${passedGates} passed` : "",
    failedGateCount > 0 ? `${failedGateCount} failed` : "",
    deferredGates > 0 ? `${deferredGates} deferred` : "",
  ].filter(Boolean).join(" · ");
  const blockerLabel = completionFailures.length > 0 ? formatCount(completionFailures.length, "blocker") : "pending";
  const verdictLabel = settledCompletion ? (completionPassed ? "accepted" : blockerLabel) : (completionPassed ? (gateProfile === "relaxed" ? "ready for review" : "structurally ready") : blockerLabel);
  return <section className="audit-section">
    <div className="section-heading"><span>Gate audit · {gateProfile}</span>{(!settledCompletion || !completionPassed) && <small data-tone={completionPassed ? "success" : "warning"}>{verdictLabel}</small>}</div>
    {!settledCompletion && <p data-meta>{gateProfile === "relaxed" ? "One semantic review runs after the candidate settles." : completionPassed ? "Plan and checks are ready; semantic review follows the settled response." : "Plan or check prerequisites are still incomplete."}</p>}
    <details className="audit-disclosure"><summary><ShieldCheck size={ICON_SIZE.sm} /><span>Acceptance standard</span><small>{gateProfile === "relaxed" ? "4 rules" : "6 rules"}</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary><div className="gate-standard-grid" aria-label="Supervisor gate standards">
      {gateProfile === "relaxed" ? <>
        <div><ShieldCheck size={ICON_SIZE.sm} /><strong>Core outcome</strong><small>Required deliverables must be materially present</small></div>
        <div><ShieldCheck size={ICON_SIZE.sm} /><strong>Relevance</strong><small>The result must directly address the task</small></div>
        <div><ShieldCheck size={ICON_SIZE.sm} /><strong>Coherence</strong><small>No material contradiction or unresolved blocker</small></div>
        <div><ShieldCheck size={ICON_SIZE.sm} /><strong>Uncertainty</strong><small>Secondary unknowns may remain explicit</small></div>
      </> : <>
        <div><ShieldCheck size={ICON_SIZE.sm} /><strong>Progress</strong><small>No terminal failure loop</small></div>
        <div><ShieldCheck size={ICON_SIZE.sm} /><strong>Evidence</strong><small>Required checks need independent, current evidence</small></div>
        <div><ShieldCheck size={ICON_SIZE.sm} /><strong>Contract</strong><small>Each acceptance criterion must be covered</small></div>
        <div><ShieldCheck size={ICON_SIZE.sm} /><strong>Claims</strong><small>Completion claims require a check, receipt, or artifact</small></div>
        <div><ShieldCheck size={ICON_SIZE.sm} /><strong>Approval</strong><small>Approval boundaries cannot be auto-resumed</small></div>
        <div><ShieldCheck size={ICON_SIZE.sm} /><strong>Delivery</strong><small>Final response must be substantive and non-empty</small></div>
      </>}
    </div></details>
    {completionFailures.length > 0 && <div className="gate-failure-list">{completionFailures.map((failure) => <GateFailureRow failure={failure} label={failure.kind} key={`${failure.kind}:${failure.key}`} />)}</div>}
    {gates.length > 0 && <details className="audit-disclosure"><summary><ShieldCheck size={ICON_SIZE.sm} /><span>Evaluation history</span><small>{evaluationSummary}</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary><div className="gate-evaluation-list">{gates.map((gate) => <details className="gate-evaluation" data-tone={gate.failures.length ? "danger" : undefined} key={gate.id}><summary><span>{gate.passed ? <Check size={ICON_SIZE.sm} /> : gate.failures.length ? <X size={ICON_SIZE.sm} /> : <Circle size={ICON_SIZE.sm} />}{formatRunValue(gate.gateType)}</span><small>{formatRunValue(gate.passed ? "passed" : gate.failures.length ? formatCount(gate.failures.length, "failure") : "deferred")}</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary><div><p className="gate-evaluator">{gate.evaluator === "llm" ? `LLM evaluation · ${gate.evaluatorModel}` : "System invariant"} · {gate.summary}</p>{gate.criterionCoverage?.length ? <div className="criterion-list">{gate.criterionCoverage.map((criterion) => <div className="criterion-row" data-tone={criterion.status === "covered" ? "success" : criterion.status === "blocked" ? "warning" : "danger"} key={criterion.criterion}><strong>{formatRunValue(criterion.status)}</strong><p>{criterion.criterion}</p><small>{criterion.reason}{criterion.evidenceRefs.length ? ` · ${criterion.evidenceRefs.join(", ")}` : ""}</small></div>)}</div> : null}{gate.failures.map((failure) => <GateFailureRow failure={failure} label={failure.disposition} key={`${failure.kind}:${failure.key}`} />)}</div></details>)}</div></details>}
    {failedGates.length > 0 && <small>Latest evaluation contains {formatCount(failedGates.length, "failed gate")}; the latest Supervisor decision determines the next action.</small>}
  </section>;
}

function CurrentOperationPanel({ run }: { run: TaskRun }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (run.status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [run.id, run.status, run.updatedAt, run.checkpoint?.updatedAt]);
  if (run.status !== "running") return null;
  const operation = deriveCurrentOperation(run, now);
  return <section className="audit-section">
    <div className="section-heading"><span>Current operation</span><small>{operation.state}</small></div>
    <div className="audit-ledger current-operation-ledger">
      <strong>{operation.toolName || "agent"}</strong>
    </div>
  </section>;
}

function SupervisorReviewPanel({ run }: { run: TaskRun }) {
  const decision = run.supervision.latestDecision;
  const progress = run.supervision.progress;
  const progressMetrics = progress ? [
    { count: progress.meaningfulChanges, singular: "meaningful change", plural: "meaningful changes" },
    { count: progress.consecutiveFailures, singular: "consecutive failure", plural: "consecutive failures" },
    { count: progress.repeatedOperations, singular: "repeated operation", plural: "repeated operations" },
  ].filter((metric) => metric.count > 0) : [];
  const hasProgressEvidence = progressMetrics.length > 0;
  if (!decision && !hasProgressEvidence && run.status !== "running") return null;
  const decisionMeta = decision ? [
    decision.evaluator === "llm" ? `LLM · ${decision.evaluatorModel}` : "System invariant",
    `${Math.round(decision.confidence * 100)}% confidence`,
    decision.attempt > 1 ? `attempt ${decision.attempt}` : "",
  ].filter(Boolean).join(" · ") : "";
  return <section className="audit-section">
    <div className="section-heading"><span>Supervisor review</span><small>{decision ? formatRunValue(decision.action) : hasProgressEvidence ? "Progress evidence" : "Observing"}</small></div>
    <div className="supervisor-verdict">
      {decision ? <><div><Eye size={ICON_SIZE.md} /><strong>{formatRunValue(decision.reasonCode)}</strong></div><small>{decisionMeta}</small><p>{decision.rationale}</p></>
        : hasProgressEvidence ? <div><Eye size={ICON_SIZE.md} /><strong>Recorded progress</strong></div>
        : <><div><Eye size={ICON_SIZE.md} /><strong>Observing execution</strong></div><p>No intervention decision has been persisted. The Supervisor is monitoring progress and will review the settled candidate against the standards below.</p></>}
      {hasProgressEvidence && <div className="run-metrics">{progressMetrics.map((metric) => <span key={metric.singular}>{formatCount(metric.count, metric.singular, metric.plural)}</span>)}</div>}
    </div>
  </section>;
}

function ContextManifestPanel({ run }: { run: TaskRun }) {
  const [history, setHistory] = useState<{ runId: string; items: ContextManifest[] } | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [expandedRunId, setExpandedRunId] = useState("");
  const [requestError, setRequestError] = useState<{ runId: string; message: string } | null>(null);
  const expanded = expandedRunId === run.id;
  const manifests = history?.runId === run.id ? history.items : [];
  const error = requestError?.runId === run.id ? requestError.message : "";
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    void api.contextManifests(run.id).then((items) => { if (active) { setHistory({ runId: run.id, items }); setSelectedId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? ""); } }).catch((cause) => { if (active) setRequestError({ runId: run.id, message: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { active = false; };
  }, [expanded, run.id, run.supervision.latestContextManifest?.id]);
  const current = manifests.find((item) => item.id === selectedId) ?? run.supervision.latestContextManifest;
  if (!current) return null;
  const previous = manifests[manifests.findIndex((item) => item.id === current.id) + 1];
  const selected = current.items.filter((item) => item.selected);
  const omitted = current.items.filter((item) => !item.selected);
  const previousSelected = new Set(previous?.items.filter((item) => item.selected).map((item) => `${item.kind}:${item.sourceId}`) ?? []);
  const currentSelected = new Set(selected.map((item) => `${item.kind}:${item.sourceId}`));
  const added = previous ? selected.filter((item) => !previousSelected.has(`${item.kind}:${item.sourceId}`)) : [];
  const removed = previous?.items.filter((item) => item.selected && !currentSelected.has(`${item.kind}:${item.sourceId}`)) ?? [];
  const estimatedTokens = selected.reduce((sum, item) => sum + item.estimatedTokens, 0);
  const hasSelectionChanges = added.length > 0 || removed.length > 0;
  const selectionSummary = [selected.length > 0 ? `${selected.length} selected` : "", omitted.length > 0 ? `${omitted.length} omitted` : ""].filter(Boolean).join(" · ");
  const selectionDiff = [added.length > 0 ? `${added.length} added` : "", removed.length > 0 ? `${removed.length} removed` : ""].filter(Boolean).join(" · ");
  return <details className="audit-section audit-disclosure" open={expanded} onToggle={(event) => { setExpandedRunId(event.currentTarget.open ? run.id : ""); if (event.currentTarget.open) setRequestError(null); }}>
    <summary><FileText size={ICON_SIZE.sm} /><span>Context manifests</span><small>{selectionSummary || "Current"}</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
    <div className="context-manifest-card">{manifests.length > 1 && <select value={current.id} onChange={(event) => setSelectedId(event.target.value)}>{manifests.map((item) => <option value={item.id} key={item.id}>attempt {item.attempt} · {item.source} · {new Date(item.createdAt).toLocaleTimeString()}</option>)}</select>}<span>{estimatedTokens > 0 ? `${formatCount(estimatedTokens, "estimated token")} · ` : ""}hash {current.manifestHash.slice(0, 12)}</span>{manifests.length > 1 && <small>{formatCount(manifests.length, "retained manifest")}</small>}{hasSelectionChanges && <span>selection diff · {selectionDiff}</span>}{selected.length > 0 && <details><summary>Selected sources</summary><div className="manifest-items">{selected.map((item) => <code key={`${item.kind}:${item.sourceId}`}>{item.kind} · {item.sourceId}</code>)}</div></details>}{omitted.length > 0 && <details><summary>Omitted sources</summary><div className="manifest-items">{omitted.map((item) => <code key={`${item.kind}:${item.sourceId}`}>{item.kind} · {item.sourceId} · {item.reason}</code>)}</div></details>}{hasSelectionChanges && <details><summary>Changes from previous manifest</summary><div className="manifest-items">{added.map((item) => <code key={`add:${item.kind}:${item.sourceId}`}>+ {item.kind} · {item.sourceId}</code>)}{removed.map((item) => <code key={`remove:${item.kind}:${item.sourceId}`}>- {item.kind} · {item.sourceId}</code>)}</div></details>}{error && <small>{error}</small>}</div>
  </details>;
}

function ArtifactsPanel({ run }: { run: TaskRun }) {
  const [selectedId, setSelectedId] = useState("");
  const [preview, setPreview] = useState<ArtifactContent | null>(null);
  const [loadingId, setLoadingId] = useState("");
  const [downloadingId, setDownloadingId] = useState("");
  const [error, setError] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const previewAuthorityRef = useRef(new LatestRequestAuthority());
  useEffect(() => { previewAuthorityRef.current.invalidate(); setSelectedId(""); setPreview(null); setError(""); setLoadingId(""); setDownloadingId(""); setDownloadError(""); }, [run.id]);
  const openArtifact = async (artifact: Artifact) => {
    if (selectedId === artifact.id && preview) { previewAuthorityRef.current.invalidate(); setSelectedId(""); setPreview(null); setError(""); setLoadingId(""); return; }
    const requestToken = previewAuthorityRef.current.begin();
    setSelectedId(artifact.id); setPreview(null); setError(""); setLoadingId(artifact.id);
    try {
      const content = await api.artifactContent(run.id, artifact.id);
      if (previewAuthorityRef.current.isCurrent(requestToken)) setPreview(content);
    } catch (cause) {
      if (previewAuthorityRef.current.isCurrent(requestToken)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (previewAuthorityRef.current.isCurrent(requestToken)) setLoadingId("");
    }
  };
  const downloadArtifact = async (artifact: Artifact) => {
    setDownloadingId(artifact.id); setDownloadError("");
    try { await api.downloadArtifact(run.id, artifact.id, artifact.title); }
    catch (cause) { setDownloadError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setDownloadingId(""); }
  };
  const closePreview = () => { previewAuthorityRef.current.invalidate(); setSelectedId(""); setPreview(null); setError(""); setLoadingId(""); };
  const selectedArtifact = run.artifacts.find((item) => item.id === selectedId);
  return <section className="audit-section">
    <div className="section-heading"><span>Artifacts</span><small>{run.artifacts.length}</small></div>
    <div className="artifact-list">{run.artifacts.map((artifact) => {
      const selected = selectedId === artifact.id;
      return <div className="artifact-row" key={artifact.id}><FileText size={ICON_SIZE.md} /><button className="artifact-open" type="button" onClick={() => void openArtifact(artifact)} aria-expanded={selected}><strong>{artifact.title}</strong><small>{artifact.kind || "artifact"}</small></button><button className="artifact-download" type="button" onClick={() => void downloadArtifact(artifact)} disabled={downloadingId === artifact.id} title={`Download ${artifact.title}`} aria-label={`Download ${artifact.title}`}><Download size={ICON_SIZE.sm} /></button></div>;
    })}</div>{downloadError && <small data-tone="danger">{downloadError}</small>}
    {selectedId && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePreview(); }}>
      <section className="modal artifact-modal" role="dialog" aria-modal="true" aria-labelledby="artifact-modal-title">
        <header><div><span>Artifact preview</span><strong id="artifact-modal-title">{selectedArtifact?.title ?? "Artifact"}</strong></div><span><button type="button" disabled={!selectedArtifact || downloadingId === selectedId} onClick={() => { if (selectedArtifact) void downloadArtifact(selectedArtifact); }} aria-label="Download artifact"><Download size={ICON_SIZE.sm} /></button><button type="button" onClick={closePreview} aria-label="Close artifact preview"><X size={ICON_SIZE.md} /></button></span></header>
        <div className="artifact-modal-body">{loadingId === selectedId ? <div className="artifact-preview-state"><Activity className="spin" size={ICON_SIZE.md} />Loading preview…</div>
          : error ? <div className="artifact-preview-state" data-tone="danger">{error}<small>Unsupported or unavailable artifacts can still be downloaded.</small></div>
          : preview ? <><div className="artifact-preview-meta"><span>{preview.format} · {formatCount(preview.bytes, "byte")}</span><small>{preview.source === "file" ? "loaded from workspace file" : "stored content"}</small></div>{preview.format === "markdown" ? <Markdown>{preview.content}</Markdown> : <pre className="artifact-text-preview">{preview.content}</pre>}</>
          : null}</div>
      </section>
    </div>}
  </section>;
}

function RunMetrics({ run }: { run: TaskRun }) {
  const hasTokenUsage = run.usage.totalTokens > 0 || run.usage.input > 0 || run.usage.output > 0;
  if (run.transcriptCount <= 0 && !hasTokenUsage) return null;
  const tokenBreakdown = [run.usage.input > 0 ? `${run.usage.input.toLocaleString()} in` : "", run.usage.output > 0 ? `${run.usage.output.toLocaleString()} out` : ""].filter(Boolean).join(" / ");
  return <div className="run-metrics">
    {run.transcriptCount > 0 && <span>{formatCount(run.transcriptCount, "message")}</span>}
    {hasTokenUsage && <>{run.usage.totalTokens > 0 && <span>{formatCount(run.usage.totalTokens, "token")}</span>}{tokenBreakdown && <span>{tokenBreakdown}</span>}</>}
  </div>;
}

function RunEvidencePanel({ run }: { run: TaskRun }) {
  const hasPlan = run.plan.length > 0;
  const hasChecks = run.checks.length > 0;
  const hasContinuations = run.continuations.length > 0;
  const groupCount = Number(hasPlan) + Number(hasChecks) + Number(hasContinuations);
  if (groupCount === 0) return null;

  const planDone = run.plan.filter((item) => item.status === "done").length;
  const checksPassed = run.checks.filter((item) => item.status === "passed" && !item.stale).length;
  const title = groupCount > 1
    ? "Execution evidence"
    : hasPlan
      ? "Plan"
      : hasChecks
        ? "Checks"
        : "Continuations";
  const summary = hasPlan
    ? `${planDone}/${run.plan.length} complete`
    : hasChecks
      ? `${checksPassed}/${run.checks.length} passed`
      : formatCount(run.continuations.length, "continuation");

  return <section className="audit-section">
    <div className="section-heading"><span>{title}</span>{groupCount === 1 && <small>{summary}</small>}</div>
    <div className="run-evidence-ledger">
      {hasPlan && <div className="run-evidence-group">
        {groupCount > 1 && <span className="run-evidence-group-label" data-label><span>Plan</span><small>{planDone}/{run.plan.length}</small></span>}
        <div className="task-list">{run.plan.map((item) => <div className="task-row" data-status={item.status} key={item.key}>{item.status === "done" ? <Check size={ICON_SIZE.md} /> : <Circle size={ICON_SIZE.sm} />}<span>{item.title}</span><small>{formatRunValue(item.status)}</small></div>)}</div>
      </div>}
      {hasChecks && <div className="run-evidence-group">
        {groupCount > 1 && <span className="run-evidence-group-label" data-label><span>Checks</span><small>{checksPassed}/{run.checks.length}</small></span>}
        <div className="task-list">{run.checks.map((check) => <div className="task-row" data-status={check.stale ? "stale" : check.status} key={check.key}>{check.status === "passed" && !check.stale ? <Check size={ICON_SIZE.md} /> : <Circle size={ICON_SIZE.sm} />}<span>{check.title}</span><small>{formatRunValue(check.stale ? "stale" : check.status)}</small></div>)}</div>
      </div>}
      {hasContinuations && <div className="run-evidence-group">
        {groupCount > 1 && <span className="run-evidence-group-label" data-label><span>Continuations</span><small>{run.continuations.length}</small></span>}
        <div className="continuation-list">{run.continuations.map((item) => <div className="continuation-row" key={item.id}><div><strong>#{item.ordinal}</strong><span>{item.reason}</span></div><small data-tone={runStatusTone(item.status)}>{formatRunValue(item.status)}{item.leaseUntil && item.status === "running" ? " · leased" : ""}</small></div>)}</div>
      </div>}
    </div>
  </section>;
}

function formatContractDecisionReason(value: string): string {
  return value.replace(/\b(\d+) semantic objective\(s\)/g, (_, count: string) => `${count} semantic objective${count === "1" ? "" : "s"}`);
}

function RunStatusNotice({ notice }: { notice: NonNullable<ReturnType<typeof runStatusNotice>> }) {
  const compact = notice.text.length > 240 || notice.text.includes(";");
  if (!compact) return <div className="run-status-note" data-tone={notice.tone}>{notice.text}</div>;
  const firstClause = notice.text.split(";", 1)[0]?.trim() ?? notice.text;
  const machinePrefixed = /^[a-z0-9_]+:\s*/i.test(firstClause);
  const readableClause = firstClause.replace(/^[a-z0-9_]+:\s*/i, "");
  const summary = machinePrefixed ? readableClause.split(": ", 1)[0]?.trim() || readableClause : readableClause;
  return <details className="run-status-note" data-tone={notice.tone}>
    <summary><span>{summary}</span><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
    <p>{notice.text}</p>
  </details>;
}

export function RunDetails({ run, toolEvents, transcriptTools }: { run: TaskRun; toolEvents: RunEvent[]; transcriptTools: Extract<TranscriptItem, { kind: "tool" }>[] }) {
  const checkpoint = run.checkpoint && !run.checkpoint.active && (run.checkpoint.currentTool || run.checkpoint.assistantPartial.trim())
    ? run.checkpoint
    : null;
  const statusLabel = formatRunStatus(run.status);
  const phaseLabel = formatRunValue(run.phase);
  const showPhase = !isRedundantRunPhase(run.status, run.phase);
  const statusNotice = runStatusNotice(run.status, run.blockedReason);
  const checkpointPosition = checkpoint ? [checkpoint.lastEventSeq > 0 ? `event ${checkpoint.lastEventSeq}` : "", checkpoint.lastTranscriptSeq > 0 ? `transcript ${checkpoint.lastTranscriptSeq}` : ""].filter(Boolean).join(" · ") : "";
  return <div className="run-details">
    <CurrentOperationPanel run={run} />
    <section className="run-summary"><div className="phase-line"><span className="status-label" data-tone={runStatusTone(run.status)}><span className="status-dot" />{statusLabel}</span>{showPhase && <span>{phaseLabel}</span>}{run.attempt > 1 && <span>attempt {run.attempt}</span>}</div><p>{run.goal}</p>{run.contract && <details className="run-contract"><summary><span>Task contract</span><small>{formatRunValue(run.contract.intent)} · {formatRunValue(run.contract.relation)}</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary><div><strong>{formatContractDecisionReason(run.contract.decisionReason)}</strong><ul>{run.contract.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul></div></details>}<RunMetrics run={run} />{statusNotice && <RunStatusNotice notice={statusNotice} />}</section>
    {checkpoint && <section className="audit-section"><div className="section-heading"><span>Checkpoint</span><small>preserved</small></div><div className="audit-ledger">{checkpointPosition && <span>{checkpointPosition}</span>}{checkpoint.currentTool && <strong>{checkpoint.currentTool.toolName}</strong>}{checkpoint.assistantPartial && <p>{checkpoint.assistantPartial.slice(-240)}</p>}</div></section>}
    <SupervisorReviewPanel run={run} />
    <GateAuditPanel run={run} />
    <ToolActivityPanel transcriptItems={transcriptTools} events={toolEvents} />
    <ContextManifestPanel run={run} />
    <RunEvidencePanel run={run} />
    {run.artifacts.length > 0 && <ArtifactsPanel run={run} />}
  </div>;
}

export type RunApproval = TaskRun["supervision"]["approvalRequests"][number];

function approvalHeading(actionType: RunApproval["actionType"]): string {
  if (actionType === "execute_external_action") return "External action needs your approval";
  if (actionType === "start_parallel_taskrun") return "Parallel TaskRun needs your approval";
  return "TaskRun needs your approval";
}

function approvalActionLabel(actionType: RunApproval["actionType"]): string {
  if (actionType === "execute_external_action") return "Approve & execute";
  if (actionType === "start_parallel_taskrun") return "Approve & start";
  return "Approve & resume";
}

export function ApprovalDock({ run, approvals, resolvingId, resolvingDecision, onResolve }: {
  run: TaskRun;
  approvals: RunApproval[];
  resolvingId: string;
  resolvingDecision: "approved" | "rejected" | "";
  onResolve: (approval: RunApproval, decision: "approved" | "rejected") => Promise<void>;
}) {
  return <section className="approval-dock" aria-label="Pending approvals" aria-live="polite">
    <header className="approval-dock-heading"><span><ShieldAlert size={ICON_SIZE.sm} />Approval required</span><small>{approvals.length} {approvals.length === 1 ? "action is" : "actions are"} paused</small></header>
    {approvals.map((approval) => {
      const approvedAttempt = approval.metadata.approvedAttempt;
      const attempt = typeof approvedAttempt === "number" ? approvedAttempt : run.attempt;
      const busy = resolvingId === approval.id;
      return <article className="approval-card" key={approval.id}>
        <span className="approval-card-icon" aria-hidden="true"><ShieldAlert size={ICON_SIZE.lg} /></span>
        <div className="approval-card-copy">
          <small>Human checkpoint · Attempt {attempt}</small>
          <strong>{approvalHeading(approval.actionType)}</strong>
          <p>{approval.reason}</p>
          {approval.actionType === "execute_external_action" && <small>Authorization is limited to Attempt {attempt}; any later Attempt requires a new approval.</small>}
        </div>
        <div className="approval-card-actions">
          <button className="control" data-variant="primary" type="button" disabled={Boolean(resolvingId)} onClick={() => void onResolve(approval, "approved")}>{busy && resolvingDecision === "approved" ? <Activity className="spin" size={ICON_SIZE.md} /> : <ShieldCheck size={ICON_SIZE.md} />}{busy && resolvingDecision === "approved" ? "Approving…" : approvalActionLabel(approval.actionType)}</button>
          <button className="control" data-tone="danger" type="button" disabled={Boolean(resolvingId)} onClick={() => void onResolve(approval, "rejected")}>{busy && resolvingDecision === "rejected" && <Activity className="spin" size={ICON_SIZE.md} />}{busy && resolvingDecision === "rejected" ? "Rejecting…" : "Reject"}</button>
        </div>
      </article>;
    })}
  </section>;
}

export interface QueuePromptProps {
  item: SessionInboxItem; index: number; editing: boolean; draft: string; busy: boolean; starting: boolean; canMoveUp: boolean; canMoveDown: boolean;
  onEdit: () => void; onDraftChange: (value: string) => void; onSave: () => void; onCancelEdit: () => void; onStart: () => void; onToggleDefer: () => void; onMergeFirst: () => void; onDelete: () => void; onMoveUp: () => void; onMoveDown: () => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void; onDragEnd: () => void; onDrop: (event: DragEvent<HTMLElement>) => void;
}

export function QueuePrompt({ item, index, editing, draft, busy, starting, canMoveUp, canMoveDown, onEdit, onDraftChange, onSave, onCancelEdit, onStart, onToggleDefer, onMergeFirst, onDelete, onMoveUp, onMoveDown, onDragStart, onDragEnd, onDrop }: QueuePromptProps) {
  return <article className="inbox-item" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={onDrop}>
    <button draggable={!busy && !editing} onDragStart={onDragStart} onDragEnd={onDragEnd} disabled={busy || editing} aria-label={`Drag prompt ${index + 1} to reorder`} title="Drag to reorder"><GripVertical size={ICON_SIZE.sm} /></button>
    <span className="inbox-position">{index + 1}</span>
    <div>{editing ? <textarea className="queue-editor" value={draft} onChange={(event) => onDraftChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") onCancelEdit(); if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) onSave(); }} autoFocus rows={2} aria-label="Edit queued prompt" /> : <><strong>{item.analysis.summary || item.content}</strong>{item.analysis.summary !== item.content && <p>{item.content}</p>}</>}<div className="inbox-routing"><span className="intent-badge">{formatRunValue(item.analysis.intent)}</span><span>{formatRunValue(item.analysis.urgency)} · priority {item.analysis.priority}</span><span>{Math.round(item.analysis.confidence * 100)}% confidence</span>{item.analysis.targetRunId && <span>→ run {item.analysis.targetRunId.slice(0, 8)}</span>}</div><small>{item.decision === "defer" ? "Deferred by user override" : item.analysis.reason}</small>{item.analysis.acceptanceCriteria.length > 0 && <details><summary>Acceptance criteria</summary><ul>{item.analysis.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul></details>}
      <div className="inbox-actions">{editing ? <><button onClick={onSave} disabled={busy || !draft.trim()}>Save</button><button onClick={onCancelEdit} disabled={busy}>Cancel</button></> : <><button data-tone="accent" onClick={onStart} disabled={busy}>{starting ? "Starting…" : "Run now"}</button><details><summary>More <ChevronDown size={ICON_SIZE.xs} /></summary><div><button onClick={onEdit} disabled={busy}><Pencil size={ICON_SIZE.xs} /> Edit</button><button onClick={onToggleDefer} disabled={busy}>{item.decision === "defer" ? "Resume" : "Defer"}</button>{index > 0 && <button onClick={onMergeFirst} disabled={busy}>Merge first</button>}<button onClick={onMoveUp} disabled={busy || !canMoveUp} aria-label={`Move queued prompt ${index + 1} up`}>Move up</button><button onClick={onMoveDown} disabled={busy || !canMoveDown} aria-label={`Move queued prompt ${index + 1} down`}>Move down</button></div></details></>}</div>
    </div>
    <button onClick={onDelete} disabled={busy} aria-label="Remove queued input"><X size={ICON_SIZE.sm} /></button>
  </article>;
}
