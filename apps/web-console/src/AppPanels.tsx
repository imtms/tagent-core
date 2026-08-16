import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  Activity, Bot, BrainCircuit, Check, ChevronDown, ChevronRight, Circle, Download, Eye,
  FileText, GripVertical, HelpCircle, Pencil, Send, ShieldAlert, ShieldCheck, Terminal, X,
} from "lucide-react";
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
import { deriveCurrentOperation } from "./current-operation";
import { formatConversationDay, formatTime } from "./time-format";

export function TAgentMark({ size = 18 }: { size?: number }) {
  return <svg className="tagent-mark" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
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

export function WorkspaceRunStatus({ session }: { session: Session }) {
  const status = session.latestRunStatus;
  if (!status) return <span className="workspace-run-status idle"><span className="workspace-status-dot" />No tasks</span>;
  return <span className={`workspace-run-status ${status}`} title={`${status}${session.latestRunPhase ? ` · ${session.latestRunPhase}` : ""}`}>
    {status === "running" ? <Activity size={10} /> : <span className="workspace-status-dot" />}
    <span>{status}</span>
  </span>;
}

export function ToolCall({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  return <details className={`tool-call ${item.isError ? "failed" : ""}`}>
    <summary><Terminal size={14} /><span>{item.toolName}</span><small>{item.isError ? "failed" : item.status}</small><ChevronRight className="tool-chevron" size={14} /></summary>
    <div className="tool-call-body"><div><strong>Arguments</strong><pre>{JSON.stringify(item.arguments, null, 2)}</pre></div><div><strong>Result</strong><pre>{item.result || "No result recorded"}</pre></div></div>
  </details>;
}

export function RunStep({ item }: { item: TranscriptItem }) {
  if (item.kind === "assistant") return <article className="run-step assistant-step"><div className="run-step-meta"><Bot size={13} /><strong>Model output</strong><small>attempt {item.attempt} · {formatTime(item.createdAt)}</small></div><div className="run-step-content"><Markdown>{item.text}</Markdown></div></article>;
  if (item.kind === "thinking") return <details className={`run-step thinking-step ${item.redacted ? "redacted" : ""}`} open={!item.redacted}><summary><BrainCircuit size={13} /><strong>{item.redacted ? "Model reasoning unavailable" : "Model reasoning"}</strong><small>attempt {item.attempt} · {formatTime(item.createdAt)}</small><ChevronRight className="tool-chevron" size={13} /></summary><div className="run-step-content"><Markdown>{item.text}</Markdown></div></details>;
  if (item.kind === "tool") return <details className={`run-step tool-step ${item.isError ? "failed" : ""}`}><summary><Terminal size={13} /><strong>{item.toolName}</strong><small>{item.status} · attempt {item.attempt}</small><ChevronRight className="tool-chevron" size={13} /></summary><div className="run-step-tool"><div><strong>Arguments</strong><pre>{JSON.stringify(item.arguments, null, 2)}</pre></div><div><strong>Result</strong><pre>{item.result || "Waiting for result…"}</pre></div></div></details>;
  return null;
}

export function UserInputCard({ request, submitting, onSubmit }: { request: UserInputRequest; submitting: boolean; onSubmit: (values: Record<string, string>) => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(request.fields.map((field) => [field.key, ""])));
  const missing = request.fields.some((field) => field.required && !values[field.key]?.trim());
  return <section className="user-input-card" aria-label="TaskRun needs more information">
    <div className="user-input-heading"><HelpCircle size={18} /><div><strong>Information needed to continue</strong><p>{request.prompt}</p></div><span>Paused</span></div>
    <ul className="user-input-needed">{request.fields.map((field) => <li key={field.key}><strong>{field.label}{field.required ? " *" : ""}</strong>{field.description && <span>{field.description}</span>}</li>)}</ul>
    <form onSubmit={(event) => { event.preventDefault(); if (!missing && !submitting) void onSubmit(values); }}>
      {request.fields.map((field) => <label key={field.key}><span>{field.label}{field.required ? " *" : ""}</span>{field.inputType === "textarea" ? <textarea rows={3} value={values[field.key] ?? ""} placeholder={field.placeholder} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} /> : <input value={values[field.key] ?? ""} placeholder={field.placeholder} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} />}{field.description && <small>{field.description}</small>}</label>)}
      <button type="submit" disabled={missing || submitting}>{submitting ? <Activity className="spin" size={15} /> : <Send size={15} />}{submitting ? "Resuming…" : "Submit and resume"}</button>
    </form>
  </section>;
}

export function ExecutionTimeline({ runId, isRunning, items, events, liveThinking, liveOutput }: { runId: string; isRunning: boolean; items: TranscriptItem[]; events: RunEvent[]; liveThinking: string; liveOutput: string }) {
  const [expanded, setExpanded] = useState(isRunning);
  const bodyRef = useRef<HTMLDivElement>(null);
  const visible = items.filter((item) => item.kind !== "user");
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
  const stepCount = visible.length + liveTools.length;
  return <section className={`execution-timeline ${expanded ? "expanded" : "collapsed"}`} aria-label="Agent execution timeline">
    <button className="execution-timeline-heading" type="button" aria-expanded={expanded} aria-controls={`execution-trace-${runId}`} onClick={() => setExpanded((current) => !current)}>
      <span>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Activity size={14} />Execution trace{isRunning && <i><span className="pulse" />Live</i>}</span>
      <small>{stepCount} step{stepCount === 1 ? "" : "s"}{!isRunning && !expanded ? " · expand to inspect" : ""}</small>
    </button>
    {expanded && <div className="execution-timeline-body" id={`execution-trace-${runId}`} ref={bodyRef}>
      {visible.map((item) => <RunStep key={`${item.seq}-${item.index ?? 0}-${item.kind}`} item={item} />)}
      {liveThinking && <details className="run-step thinking-step live" open><summary><BrainCircuit size={13} /><strong>Model reasoning</strong><span className="live-label"><span className="pulse" />Live</span><ChevronRight className="tool-chevron" size={13} /></summary><div className="run-step-content"><LiveText>{liveThinking}</LiveText></div></details>}
      {liveTools.map((event) => <div className={`run-step live-tool-step ${event.data.isError ? "failed" : ""}`} key={`${event.seq}-${event.type}`}><Terminal size={13} /><strong>{String(event.data.toolName ?? "tool")}</strong><small>{event.type === "tool.started" ? "running" : event.data.isError ? "failed" : "completed"}</small></div>)}
      {liveOutput && <article className="run-step assistant-step live"><div className="run-step-meta"><Bot size={13} /><strong>Model output</strong><span className="live-label"><span className="pulse" />Live</span></div><div className="run-step-content"><LiveText>{liveOutput}</LiveText></div></article>}
    </div>}
  </section>;
}

export function ToolActivityPanel({ transcriptItems, events }: { transcriptItems: Extract<TranscriptItem, { kind: "tool" }>[]; events: RunEvent[] }) {
  const latestByTool = new Map<string, RunEvent>();
  for (const event of events) {
    if (!event.type.startsWith("tool.")) continue;
    latestByTool.set(String(event.data.toolCallId ?? event.data.toolName ?? event.seq), event);
  }
  const live = [...latestByTool.values()].slice(-8).reverse();
  const running = live.filter((event) => event.type === "tool.started").length;
  const failed = transcriptItems.filter((item) => item.isError).length;
  return <section className="panel-section tool-audit-section">
    <div className="section-title"><span>Tool activity</span><small>{running ? `${running} running` : `${transcriptItems.length} calls`}{failed ? ` · ${failed} failed` : ""}</small></div>
    <p className="audit-help">Operational detail is kept out of the conversation. Expand it here only when execution evidence needs inspection.</p>
    {live.length > 0 && <details className="audit-disclosure"><summary><Activity size={13} /><span>Live and recent activity</span><small>{live.length}</small><ChevronRight className="tool-chevron" size={13} /></summary><div className="tool-stack">{live.map((event) => <div className="tool-row" key={`${event.seq}-${event.type}`}><Terminal size={14} /><span>{String(event.data.toolName ?? "tool")}</span><small>{event.type === "tool.started" ? "running" : event.data.isError ? "failed" : "done"}</small></div>)}</div></details>}
    <details className="audit-disclosure"><summary><Terminal size={13} /><span>Recorded tool calls</span><small>{transcriptItems.length}</small><ChevronRight className="tool-chevron" size={13} /></summary><div className="tool-history-list">{transcriptItems.length ? transcriptItems.map((item) => <ToolCall key={`${item.seq}-${item.index}`} item={item} />) : <p className="muted">No tool calls recorded for this TaskRun.</p>}</div></details>
  </section>;
}

export function GateAuditPanel({ run }: { run: TaskRun }) {
  const gateProfile = run.contract?.executionPolicy?.gateProfile ?? "strict";
  if (gateProfile === "off") return <section className="panel-section gate-audit-section gate-disabled">
    <div className="section-title"><span>Gate audit</span><small>disabled</small></div>
    <div className="completion-verdict passed"><strong>Direct delivery</strong><span>This TaskRun skips completion acceptance. Safety approvals and tool policies still apply.</span></div>
  </section>;
  const gates = run.supervision.latestGates;
  const failedGates = gates.filter((gate) => !gate.passed && gate.failures.length > 0);
  const settledCompletion = gates.find((gate) => gate.gateType === "completion");
  const completionPassed = settledCompletion?.passed ?? run.completionGate.passed;
  const completionFailures = settledCompletion?.failures ?? run.completionGate.failures.map((failure) => ({ ...failure, disposition: "auto_fixable" }));
  const verdictLabel = settledCompletion ? (completionPassed ? "accepted" : `${completionFailures.length} blocker(s)`) : (completionPassed ? (gateProfile === "relaxed" ? "ready for review" : "structurally ready") : `${completionFailures.length} blocker(s)`);
  return <section className="panel-section gate-audit-section">
    <div className="section-title"><span>Gate audit · {gateProfile}</span><small className={completionPassed ? "audit-pass" : "audit-warn"}>{verdictLabel}</small></div>
    <div className="gate-standard-grid" aria-label="Supervisor gate standards">
      {gateProfile === "relaxed" ? <>
        <div><ShieldCheck size={14} /><strong>Core outcome</strong><small>Required deliverables must be materially present</small></div>
        <div><ShieldCheck size={14} /><strong>Relevance</strong><small>The result must directly address the task</small></div>
        <div><ShieldCheck size={14} /><strong>Coherence</strong><small>No material contradiction or unresolved blocker</small></div>
        <div><ShieldCheck size={14} /><strong>Uncertainty</strong><small>Secondary unknowns may remain explicit</small></div>
      </> : <>
        <div><ShieldCheck size={14} /><strong>Progress</strong><small>No terminal failure loop</small></div>
        <div><ShieldCheck size={14} /><strong>Evidence</strong><small>Required checks need independent, current evidence</small></div>
        <div><ShieldCheck size={14} /><strong>Contract</strong><small>Each acceptance criterion must be covered</small></div>
        <div><ShieldCheck size={14} /><strong>Claims</strong><small>Completion claims require a check, receipt, or artifact</small></div>
        <div><ShieldCheck size={14} /><strong>Approval</strong><small>Approval boundaries cannot be auto-resumed</small></div>
        <div><ShieldCheck size={14} /><strong>Delivery</strong><small>Final response must be substantive and non-empty</small></div>
      </>}
    </div>
    <div className={`completion-verdict ${completionPassed ? "passed" : "pending"}`}><strong>{settledCompletion ? (completionPassed ? "Settled candidate accepted" : "Settled candidate rejected") : gateProfile === "relaxed" ? "Ready for outcome review" : (completionPassed ? "Structural prerequisites ready" : "Structural prerequisites incomplete")}</strong><span>{settledCompletion ? (completionPassed ? (gateProfile === "relaxed" ? "The result-oriented review accepted the core outcome; explicit secondary uncertainty did not force continuation." : "The latest persisted Supervisor evaluation accepted progress, evidence, contract coverage, claims, and delivery.") : "Supervisor must continue, request evidence, block, or seek approval before accepting delivery.") : gateProfile === "relaxed" ? "No plan or trusted-check prerequisite applies; one semantic review runs after the candidate settles." : (completionPassed ? "Plan and checks are ready; final semantic review still occurs after the candidate response settles." : "Plan or check prerequisites must be satisfied before final semantic review.")}</span></div>
    {completionFailures.length > 0 && <div className="gate-failure-list">{completionFailures.map((failure) => <div key={`${failure.kind}:${failure.key}`}><span>{failure.kind}</span><strong>{failure.key}</strong><p>{failure.reason}</p></div>)}</div>}
    {gates.length > 0 ? <div className="gate-evaluation-list">{gates.map((gate) => <details className={`gate-evaluation ${gate.passed ? "passed" : gate.failures.length ? "failed" : "deferred"}`} key={gate.id}><summary><span>{gate.passed ? <Check size={13} /> : gate.failures.length ? <X size={13} /> : <Circle size={13} />}{gate.gateType}</span><small>{gate.passed ? "passed" : gate.failures.length ? `${gate.failures.length} failure(s)` : "deferred"}</small><ChevronRight className="tool-chevron" size={13} /></summary><div><p className="gate-evaluator">{gate.evaluator === "llm" ? `LLM evaluation · ${gate.evaluatorModel}` : "System invariant"} · {gate.summary}</p>{gate.criterionCoverage?.length ? <div className="criterion-list">{gate.criterionCoverage.map((criterion) => <div className={`criterion-row ${criterion.status}`} key={criterion.criterion}><strong>{criterion.status}</strong><p>{criterion.criterion}</p><small>{criterion.reason}{criterion.evidenceRefs.length ? ` · ${criterion.evidenceRefs.join(", ")}` : ""}</small></div>)}</div> : null}{gate.failures.map((failure) => <div className="gate-detail" key={`${failure.kind}:${failure.key}`}><span>{failure.disposition.replaceAll("_", " ")}</span><strong>{failure.key}</strong><p>{failure.reason}</p></div>)}</div></details>)}</div> : <p className="muted">No settled gate evaluation yet. Standards above show what the Supervisor will review.</p>}
    {failedGates.length > 0 && <small className="audit-footnote">Latest evaluation contains {failedGates.length} failed gate{failedGates.length === 1 ? "" : "s"}; the latest Supervisor decision determines the next action.</small>}
  </section>;
}

export function CurrentOperationPanel({ run }: { run: TaskRun }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (run.status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [run.id, run.status, run.updatedAt, run.checkpoint?.updatedAt]);
  const operation = deriveCurrentOperation(run, now);
  return <section className={`panel-section current-operation ${operation.state}`}>
    <div className="section-title"><span>Current operation</span><small>{operation.state}</small></div>
    <div className="checkpoint-card">
      <strong>{operation.toolName || "agent"}</strong>
    </div>
  </section>;
}

export function ContextManifestPanel({ run }: { run: TaskRun }) {
  const [manifests, setManifests] = useState<ContextManifest[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api.contextManifests(run.id).then((items) => { if (active) { setManifests(items); setSelectedId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? ""); } }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [run.id, run.supervision.latestContextManifest?.id]);
  const current = manifests.find((item) => item.id === selectedId) ?? run.supervision.latestContextManifest;
  if (!current) return null;
  const previous = manifests[manifests.findIndex((item) => item.id === current.id) + 1];
  const selected = current.items.filter((item) => item.selected);
  const omitted = current.items.filter((item) => !item.selected);
  const previousSelected = new Set(previous?.items.filter((item) => item.selected).map((item) => `${item.kind}:${item.sourceId}`) ?? []);
  const currentSelected = new Set(selected.map((item) => `${item.kind}:${item.sourceId}`));
  const added = selected.filter((item) => !previousSelected.has(`${item.kind}:${item.sourceId}`));
  const removed = previous?.items.filter((item) => item.selected && !currentSelected.has(`${item.kind}:${item.sourceId}`)) ?? [];
  return <section className="panel-section"><div className="section-title"><span>Context manifests</span><small>{manifests.length} retained</small></div><div className="checkpoint-card context-manifest-card">{manifests.length > 1 && <select value={current.id} onChange={(event) => setSelectedId(event.target.value)}>{manifests.map((item) => <option value={item.id} key={item.id}>attempt {item.attempt} · {item.source} · {new Date(item.createdAt).toLocaleTimeString()}</option>)}</select>}<strong>{selected.length} selected · {omitted.length} omitted</strong><span>{selected.reduce((sum, item) => sum + item.estimatedTokens, 0).toLocaleString()} estimated tokens · hash {current.manifestHash.slice(0, 12)}</span>{previous && <span>diff +{added.length} / -{removed.length} selected sources</span>}<details><summary>Selected sources</summary><div className="manifest-items">{selected.map((item) => <code key={`${item.kind}:${item.sourceId}`}>{item.kind} · {item.sourceId}</code>)}</div></details><details><summary>Omitted sources</summary><div className="manifest-items">{omitted.length ? omitted.map((item) => <code key={`${item.kind}:${item.sourceId}`}>{item.kind} · {item.sourceId} · {item.reason}</code>) : <small>None</small>}</div></details>{previous && <details><summary>Changes from previous manifest</summary><div className="manifest-items">{added.map((item) => <code key={`add:${item.kind}:${item.sourceId}`}>+ {item.kind} · {item.sourceId}</code>)}{removed.map((item) => <code key={`remove:${item.kind}:${item.sourceId}`}>- {item.kind} · {item.sourceId}</code>)}{!added.length && !removed.length && <small>No selected-source changes.</small>}</div></details>}{error && <small>{error}</small>}</div></section>;
}

export function ArtifactsPanel({ run }: { run: TaskRun }) {
  const [selectedId, setSelectedId] = useState("");
  const [preview, setPreview] = useState<ArtifactContent | null>(null);
  const [loadingId, setLoadingId] = useState("");
  const [downloadingId, setDownloadingId] = useState("");
  const [error, setError] = useState("");
  const [downloadError, setDownloadError] = useState("");
  useEffect(() => { setSelectedId(""); setPreview(null); setError(""); setLoadingId(""); setDownloadingId(""); setDownloadError(""); }, [run.id]);
  const openArtifact = async (artifact: Artifact) => {
    if (selectedId === artifact.id && preview) { setSelectedId(""); setPreview(null); setError(""); return; }
    setSelectedId(artifact.id); setPreview(null); setError(""); setLoadingId(artifact.id);
    try { setPreview(await api.artifactContent(run.id, artifact.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoadingId(""); }
  };
  const downloadArtifact = async (artifact: Artifact) => {
    setDownloadingId(artifact.id); setDownloadError("");
    try { await api.downloadArtifact(run.id, artifact.id, artifact.title); }
    catch (cause) { setDownloadError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setDownloadingId(""); }
  };
  const closePreview = () => { setSelectedId(""); setPreview(null); setError(""); setLoadingId(""); };
  const selectedArtifact = run.artifacts.find((item) => item.id === selectedId);
  return <section className="panel-section artifacts-section">
    <div className="section-title"><span>Artifacts</span><small>{run.artifacts.length}</small></div>
    <div className="artifact-list">{run.artifacts.length ? run.artifacts.map((artifact) => {
      const selected = selectedId === artifact.id;
      return <div className={`artifact-entry ${selected ? "selected" : ""}`} key={artifact.id}>
        <div className="artifact-row"><FileText size={15} /><button type="button" onClick={() => void openArtifact(artifact)} aria-expanded={selected}><strong>{artifact.title}</strong><small>{artifact.kind || "artifact"}</small></button><button type="button" onClick={() => void downloadArtifact(artifact)} disabled={downloadingId === artifact.id} title={`Download ${artifact.title}`} aria-label={`Download ${artifact.title}`}><Download size={14} /></button></div>
      </div>;
    }) : <p className="muted">No artifacts.</p>}</div>{downloadError && <small className="artifact-download-error">{downloadError}</small>}
    {selectedId && <div className="artifact-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePreview(); }}>
      <section className="artifact-modal" role="dialog" aria-modal="true" aria-labelledby="artifact-modal-title">
        <header><div><span>Artifact preview</span><strong id="artifact-modal-title">{selectedArtifact?.title ?? "Artifact"}</strong></div><span className="artifact-modal-actions"><button type="button" disabled={!selectedArtifact || downloadingId === selectedId} onClick={() => { if (selectedArtifact) void downloadArtifact(selectedArtifact); }}><Download size={14} /> Download</button><button type="button" onClick={closePreview} aria-label="Close artifact preview"><X size={16} /></button></span></header>
        <div className="artifact-modal-body">{loadingId === selectedId ? <div className="artifact-preview-state"><Activity className="spin" size={15} />Loading preview…</div>
          : error ? <div className="artifact-preview-state failed">{error}<small>Unsupported or unavailable artifacts can still be downloaded.</small></div>
          : preview ? <><div className="artifact-preview-meta"><span>{preview.format} · {preview.bytes.toLocaleString()} bytes</span><small>{preview.source === "file" ? "loaded from workspace file" : "stored content"}</small></div>{preview.format === "markdown" ? <Markdown>{preview.content}</Markdown> : <pre className="artifact-text-preview">{preview.content}</pre>}</>
          : null}</div>
      </section>
    </div>}
  </section>;
}

export function RunDetails({ run, toolEvents, transcriptTools }: { run: TaskRun; toolEvents: RunEvent[]; transcriptTools: Extract<TranscriptItem, { kind: "tool" }>[] }) {
  return <div className="run-details">
    <CurrentOperationPanel run={run} />
    <section className="run-summary"><div className="phase-line"><span className={`phase-badge ${run.status}`}>{run.status}</span><span>{run.phase}</span><span>attempt {run.attempt}</span></div><p>{run.goal}</p>{run.contract && <div className="run-contract"><span>{run.contract.intent.replaceAll("_", " ")} · {run.contract.relation}</span><small>{run.contract.decisionReason}</small><ul>{run.contract.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul></div>}<div className="run-metrics"><span>{run.transcriptCount} messages</span><span>{run.usage.totalTokens.toLocaleString()} tokens</span><span>{run.usage.input.toLocaleString()} in / {run.usage.output.toLocaleString()} out</span><span>token usage is observational only</span></div>{run.blockedReason && <div className="blocked-note">{run.blockedReason}</div>}</section>
    {run.checkpoint && <section className="panel-section"><div className="section-title"><span>Checkpoint</span><small>{run.checkpoint.active ? "active" : "preserved"}</small></div><div className="checkpoint-card"><span>event {run.checkpoint.lastEventSeq} · transcript {run.checkpoint.lastTranscriptSeq}</span>{run.checkpoint.currentTool && <strong>{run.checkpoint.currentTool.toolName}</strong>}{run.checkpoint.assistantPartial && <p>{run.checkpoint.assistantPartial.slice(-240)}</p>}</div></section>}
    <section className="panel-section supervisor-audit-section"><div className="section-title"><span>Supervisor review</span><small>{run.supervision.latestDecision?.action.replaceAll("_", " ") ?? "observing"}</small></div><div className="supervisor-verdict">{run.supervision.latestDecision ? <><div><Eye size={15} /><strong>{run.supervision.latestDecision.reasonCode.replaceAll("_", " ")}</strong><span>{run.supervision.latestDecision.evaluator === "llm" ? `LLM · ${run.supervision.latestDecision.evaluatorModel}` : "System invariant"} · {Math.round(run.supervision.latestDecision.confidence * 100)}% confidence · attempt {run.supervision.latestDecision.attempt}</span></div><p>{run.supervision.latestDecision.rationale}</p></> : <><div><Eye size={15} /><strong>Observing execution</strong></div><p>No intervention decision has been persisted. The Supervisor is monitoring progress and will review the settled candidate against the standards below.</p></>}{run.supervision.progress && <div className="progress-audit"><span>{run.supervision.progress.meaningfulChanges} meaningful changes</span><span>{run.supervision.progress.consecutiveFailures} consecutive failures</span><span>{run.supervision.progress.repeatedOperations} repeated operations</span></div>}</div></section>
    <GateAuditPanel run={run} />
    <ToolActivityPanel transcriptItems={transcriptTools} events={toolEvents} />
    <ContextManifestPanel run={run} />
    <section className="panel-section"><div className="section-title"><span>Plan</span><small>{run.plan.filter((item) => item.status === "done").length}/{run.plan.length}</small></div><div className="task-list">{run.plan.length ? run.plan.map((item) => <div className="task-row" key={item.key}>{item.status === "done" ? <Check size={15} /> : <Circle size={14} />}<span>{item.title}</span><small>{item.status}</small></div>) : <p className="muted">No structured plan.</p>}</div></section>
    <section className="panel-section"><div className="section-title"><span>Checks</span><small>{run.checks.filter((item) => item.status === "passed" && !item.stale).length}/{run.checks.length}</small></div><div className="task-list">{run.checks.length ? run.checks.map((check) => <div className="task-row" key={check.key}>{check.status === "passed" && !check.stale ? <Check size={15} /> : <Circle size={14} />}<span>{check.title}</span><small>{check.stale ? "stale" : check.status}</small></div>) : <p className="muted">No required checks.</p>}</div></section>
    <section className="panel-section"><div className="section-title"><span>Continuations</span><small>{run.continuations.length}</small></div><div className="task-list">{run.continuations.length ? run.continuations.map((item) => <div className="continuation-row" key={item.id}><div><strong>#{item.ordinal}</strong><span>{item.reason}</span></div><small className={`continuation-status ${item.status}`}>{item.status}{item.leaseUntil && item.status === "running" ? " · leased" : ""}</small></div>) : <p className="muted">No automatic continuation.</p>}</div></section>
    <ArtifactsPanel run={run} />
  </div>;
}

export type RunApproval = TaskRun["supervision"]["approvalRequests"][number];

export function approvalHeading(actionType: RunApproval["actionType"]): string {
  if (actionType === "execute_external_action") return "External action needs your approval";
  if (actionType === "start_parallel_taskrun") return "Parallel TaskRun needs your approval";
  return "TaskRun needs your approval";
}

export function approvalActionLabel(actionType: RunApproval["actionType"]): string {
  if (actionType === "execute_external_action") return "Approve & execute";
  if (actionType === "start_parallel_taskrun") return "Approve & start";
  return "Approve & resume";
}

export function approvalResolutionNotice(actionType: RunApproval["actionType"], decision: "approved" | "rejected"): string {
  if (decision === "rejected") return actionType === "start_parallel_taskrun"
    ? "Approval rejected. Parallel TaskRun was not started."
    : "Approval rejected. TaskRun remains paused.";
  if (actionType === "start_parallel_taskrun") return "Approval recorded. Parallel TaskRun started.";
  if (actionType === "execute_external_action") return "Approval recorded. External action authorized and TaskRun resumed.";
  return "Approval recorded. TaskRun resumed.";
}

export function ApprovalDock({ run, approvals, resolvingId, resolvingDecision, onResolve }: {
  run: TaskRun;
  approvals: RunApproval[];
  resolvingId: string;
  resolvingDecision: "approved" | "rejected" | "";
  onResolve: (approval: RunApproval, decision: "approved" | "rejected") => Promise<void>;
}) {
  return <section className="approval-dock" aria-label="Pending approvals" aria-live="polite">
    <header className="approval-dock-heading"><span><ShieldAlert size={14} />Approval required</span><small>{approvals.length} {approvals.length === 1 ? "action is" : "actions are"} paused</small></header>
    {approvals.map((approval) => {
      const approvedAttempt = approval.metadata.approvedAttempt;
      const attempt = typeof approvedAttempt === "number" ? approvedAttempt : run.attempt;
      const busy = resolvingId === approval.id;
      return <article className="approval-card" key={approval.id}>
        <span className="approval-card-icon" aria-hidden="true"><ShieldAlert size={18} /></span>
        <div className="approval-card-copy">
          <span>Human checkpoint · Attempt {attempt}</span>
          <strong>{approvalHeading(approval.actionType)}</strong>
          <p>{approval.reason}</p>
        </div>
        <div className="approval-card-actions">
          <button className="approval-approve" type="button" disabled={Boolean(resolvingId)} onClick={() => void onResolve(approval, "approved")}>{busy && resolvingDecision === "approved" ? <Activity className="spin" size={15} /> : <ShieldCheck size={15} />}{busy && resolvingDecision === "approved" ? "Approving…" : approvalActionLabel(approval.actionType)}</button>
          <button className="approval-reject" type="button" disabled={Boolean(resolvingId)} onClick={() => void onResolve(approval, "rejected")}>{busy && resolvingDecision === "rejected" && <Activity className="spin" size={15} />}{busy && resolvingDecision === "rejected" ? "Rejecting…" : "Reject"}</button>
        </div>
      </article>;
    })}
  </section>;
}

export interface QueuePromptProps {
  item: SessionInboxItem; index: number; editing: boolean; draft: string; busy: boolean; starting: boolean; dragging: boolean; canMoveUp: boolean; canMoveDown: boolean;
  onEdit: () => void; onDraftChange: (value: string) => void; onSave: () => void; onCancelEdit: () => void; onStart: () => void; onToggleDefer: () => void; onMergeFirst: () => void; onDelete: () => void; onMoveUp: () => void; onMoveDown: () => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void; onDragEnd: () => void; onDrop: (event: DragEvent<HTMLElement>) => void;
}

export function QueuePrompt({ item, index, editing, draft, busy, starting, dragging, canMoveUp, canMoveDown, onEdit, onDraftChange, onSave, onCancelEdit, onStart, onToggleDefer, onMergeFirst, onDelete, onMoveUp, onMoveDown, onDragStart, onDragEnd, onDrop }: QueuePromptProps) {
  return <article className={`inbox-item ${dragging ? "dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={onDrop}>
    <button className="queue-drag-handle" draggable={!busy && !editing} onDragStart={onDragStart} onDragEnd={onDragEnd} disabled={busy || editing} aria-label={`Drag prompt ${index + 1} to reorder`} title="Drag to reorder"><GripVertical size={14} /></button>
    <span className="inbox-position">{index + 1}</span>
    <div>{editing ? <textarea className="queue-editor" value={draft} onChange={(event) => onDraftChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") onCancelEdit(); if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) onSave(); }} autoFocus rows={2} aria-label="Edit queued prompt" /> : <><strong>{item.analysis.summary || item.content}</strong>{item.analysis.summary !== item.content && <p className="inbox-source">{item.content}</p>}</>}<div className="inbox-routing"><span className={`intent-badge ${item.analysis.intent}`}>{item.analysis.intent.replaceAll("_", " ")}</span><span>{item.analysis.urgency} · priority {item.analysis.priority}</span><span>{Math.round(item.analysis.confidence * 100)}% confidence</span>{item.analysis.targetRunId && <span>→ run {item.analysis.targetRunId.slice(0, 8)}</span>}</div><small>{item.decision === "defer" ? "Deferred by user override" : item.analysis.reason}</small>{item.analysis.acceptanceCriteria.length > 0 && <details className="inbox-contract"><summary>Acceptance criteria</summary><ul>{item.analysis.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul></details>}
      <span className="inbox-actions">{editing ? <><button onClick={onSave} disabled={busy || !draft.trim()}>Save</button><button onClick={onCancelEdit} disabled={busy}>Cancel</button></> : <><button onClick={onEdit} disabled={busy}><Pencil size={12} /> Edit</button><button className="run-now" onClick={onStart} disabled={busy}>{starting ? "Starting…" : "Run now"}</button><button onClick={onToggleDefer} disabled={busy}>{item.decision === "defer" ? "Resume" : "Defer"}</button>{index > 0 && <button onClick={onMergeFirst} disabled={busy}>Merge first</button>}<button onClick={onMoveUp} disabled={busy || !canMoveUp} aria-label={`Move queued prompt ${index + 1} up`}>Move up</button><button onClick={onMoveDown} disabled={busy || !canMoveDown} aria-label={`Move queued prompt ${index + 1} down`}>Move down</button></>}</span>
    </div>
    <button onClick={onDelete} disabled={busy} aria-label="Remove queued input"><X size={14} /></button>
  </article>;
}
