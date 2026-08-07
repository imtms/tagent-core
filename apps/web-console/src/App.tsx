import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Activity, Bot, BrainCircuit, Check, ChevronDown, ChevronRight, Circle, Download, Eye, FileText, GripVertical, HelpCircle, Menu, Moon, PanelLeftClose, PanelLeftOpen, PanelRight, PanelRightClose, PanelRightOpen, Pencil, Play, Plus, Send, ShieldCheck, SlidersHorizontal, Sparkles, Square, Sun, Target, Terminal, X } from "lucide-react";
import { api, subscribe, type Artifact, type ArtifactContent, type CaptureJob, type LearningFeatureState, type Message, type RunEvent, type RuntimeStatus, type Session, type ContextManifest, type SessionInboxItem, type TaskRun, type TranscriptItem, type UserInputRequest } from "./api";
import { LiveText, Markdown } from "./Markdown";
import { createRequestId } from "./id";
import { deriveCurrentOperation } from "./current-operation";
const MemoryPanel = lazy(() => import("./MemoryPanel").then((module) => ({ default: module.MemoryPanel })));
const LearningCenter = lazy(() => import("./LearningCenter").then((module) => ({ default: module.LearningCenter })));
const GoalsPanel = lazy(() => import("./GoalsPanel").then((module) => ({ default: module.GoalsPanel })));

const formatTime = (value: number) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(value);
const workspaceEmojis = ["💬", "🧠", "🛠️", "🚀", "📚", "🔬", "🎨", "📦", "🧭", "⚙️"] as const;
const reasoningEfforts = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Theme = "light" | "dark";

function storedBoolean(key: string): boolean {
  try { return globalThis.localStorage?.getItem(key) === "true"; } catch { return false; }
}

function storedWorkspaceEmojis(): Record<string, string> {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem("tagent.workspace-emojis") ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch { return {}; }
}

function storedTheme(): Theme {
  try {
    const saved = globalThis.localStorage?.getItem("tagent.theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* Browser storage is optional. */ }
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function MemoryExtraction({ job }: { job: CaptureJob | null | undefined }) {
  if (job === undefined) return <div className="turn-memory loading"><BrainCircuit size={13} /><span><strong>Memory extraction</strong><small>Checking this turn…</small></span></div>;
  if (!job) return <div className="turn-memory empty"><BrainCircuit size={13} /><span><strong>Memory extraction</strong><small>No extraction record for this turn</small></span></div>;
  const completed = job.status === "completed";
  const empty = job.status === "completed_empty";
  const failed = job.status === "dead_letter" || job.status === "retryable_failed";
  const count = job.persistedCount ?? job.proposalCount ?? 0;
  const detail = completed
    ? `${count} ${count === 1 ? "memory" : "memories"} extracted`
    : empty ? "No durable memory extracted"
    : failed ? `Extraction failed${job.errorCode ? ` · ${job.errorCode}` : ""}`
    : job.status === "running" ? "Extracting durable memory…" : "Queued for extraction";
  return <div className={`turn-memory ${completed ? "completed" : empty ? "empty" : failed ? "failed" : job.status}`} title={`Capture job ${job.id}`}><BrainCircuit size={13} /><span><strong>Memory extraction</strong><small>{detail}</small></span>{completed && <b>{count}</b>}</div>;
}

const ChatMessage = memo(function ChatMessage({ message, memoryEnabled, memoryJob }: { message: Message; memoryEnabled: boolean; memoryJob?: CaptureJob | null }) {
  return <article className={`message ${message.role}`}><div className="message-meta"><span>{message.role === "user" ? "You" : "TAgent"}</span><time>{formatTime(message.createdAt)}</time></div><div className="message-body"><Markdown>{message.content}</Markdown></div>{memoryEnabled && message.role === "user" && <MemoryExtraction job={memoryJob} />}</article>;
});

function WorkspaceRunStatus({ session }: { session: Session }) {
  const status = session.latestRunStatus;
  if (!status) return <span className="workspace-run-status idle"><Circle size={8} />No tasks</span>;
  return <span className={`workspace-run-status ${status}`} title={`${status}${session.latestRunPhase ? ` · ${session.latestRunPhase}` : ""}`}>
    {status === "running" ? <Activity size={10} /> : <span className="workspace-status-dot" />}
    <span>{status}</span>
  </span>;
}

function ToolCall({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  return <details className={`tool-call ${item.isError ? "failed" : ""}`}>
    <summary><Terminal size={14} /><span>{item.toolName}</span><small>{item.isError ? "failed" : item.status}</small><ChevronRight className="tool-chevron" size={14} /></summary>
    <div className="tool-call-body"><div><strong>Arguments</strong><pre>{JSON.stringify(item.arguments, null, 2)}</pre></div><div><strong>Result</strong><pre>{item.result || "No result recorded"}</pre></div></div>
  </details>;
}

function RunStep({ item }: { item: TranscriptItem }) {
  if (item.kind === "assistant") return <article className="run-step assistant-step"><div className="run-step-meta"><Bot size={13} /><strong>Model output</strong><small>attempt {item.attempt} · {formatTime(item.createdAt)}</small></div><div className="run-step-content"><Markdown>{item.text}</Markdown></div></article>;
  if (item.kind === "thinking") return <details className={`run-step thinking-step ${item.redacted ? "redacted" : ""}`} open={!item.redacted}><summary><BrainCircuit size={13} /><strong>{item.redacted ? "Model reasoning unavailable" : "Model reasoning"}</strong><small>attempt {item.attempt} · {formatTime(item.createdAt)}</small><ChevronRight className="tool-chevron" size={13} /></summary><div className="run-step-content"><Markdown>{item.text}</Markdown></div></details>;
  if (item.kind === "tool") return <details className={`run-step tool-step ${item.isError ? "failed" : ""}`}><summary><Terminal size={13} /><strong>{item.toolName}</strong><small>{item.status} · attempt {item.attempt}</small><ChevronRight className="tool-chevron" size={13} /></summary><div className="run-step-tool"><div><strong>Arguments</strong><pre>{JSON.stringify(item.arguments, null, 2)}</pre></div><div><strong>Result</strong><pre>{item.result || "Waiting for result…"}</pre></div></div></details>;
  return null;
}

function UserInputCard({ request, submitting, onSubmit }: { request: UserInputRequest; submitting: boolean; onSubmit: (values: Record<string, string>) => Promise<void> }) {
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

function ExecutionTimeline({ runId, isRunning, items, events, liveThinking, liveOutput }: { runId: string; isRunning: boolean; items: TranscriptItem[]; events: RunEvent[]; liveThinking: string; liveOutput: string }) {
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

function ToolActivityPanel({ transcriptItems, events }: { transcriptItems: Extract<TranscriptItem, { kind: "tool" }>[]; events: RunEvent[] }) {
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

function GateAuditPanel({ run }: { run: TaskRun }) {
  const gates = run.supervision.latestGates;
  const failedGates = gates.filter((gate) => !gate.passed);
  const settledCompletion = gates.find((gate) => gate.gateType === "completion");
  const completionPassed = settledCompletion?.passed ?? run.completionGate.passed;
  const completionFailures = settledCompletion?.failures ?? run.completionGate.failures.map((failure) => ({ ...failure, disposition: "auto_fixable" }));
  const verdictLabel = settledCompletion ? (completionPassed ? "accepted" : `${completionFailures.length} blocker(s)`) : (completionPassed ? "structurally ready" : `${completionFailures.length} blocker(s)`);
  return <section className="panel-section gate-audit-section">
    <div className="section-title"><span>Gate audit</span><small className={completionPassed ? "audit-pass" : "audit-warn"}>{verdictLabel}</small></div>
    <div className="gate-standard-grid" aria-label="Supervisor gate standards">
      <div><ShieldCheck size={14} /><strong>Progress</strong><small>No terminal failure loop</small></div>
      <div><ShieldCheck size={14} /><strong>Evidence</strong><small>Required checks need independent, current evidence</small></div>
      <div><ShieldCheck size={14} /><strong>Contract</strong><small>Each acceptance criterion must be covered</small></div>
      <div><ShieldCheck size={14} /><strong>Claims</strong><small>Completion claims require a check, receipt, or artifact</small></div>
      <div><ShieldCheck size={14} /><strong>Approval</strong><small>Approval boundaries cannot be auto-resumed</small></div>
      <div><ShieldCheck size={14} /><strong>Delivery</strong><small>Final response must be substantive and non-empty</small></div>
    </div>
    <div className={`completion-verdict ${completionPassed ? "passed" : "pending"}`}><strong>{settledCompletion ? (completionPassed ? "Settled candidate accepted" : "Settled candidate rejected") : (completionPassed ? "Structural prerequisites ready" : "Structural prerequisites incomplete")}</strong><span>{settledCompletion ? (completionPassed ? "The latest persisted Supervisor evaluation accepted progress, evidence, contract coverage, claims, and delivery." : "Supervisor must continue, request evidence, block, or seek approval before accepting delivery.") : (completionPassed ? "Plan and checks are ready; final semantic review still occurs after the candidate response settles." : "Plan or check prerequisites must be satisfied before final semantic review.")}</span></div>
    {completionFailures.length > 0 && <div className="gate-failure-list">{completionFailures.map((failure) => <div key={`${failure.kind}:${failure.key}`}><span>{failure.kind}</span><strong>{failure.key}</strong><p>{failure.reason}</p></div>)}</div>}
    {gates.length > 0 ? <div className="gate-evaluation-list">{gates.map((gate) => <details className={`gate-evaluation ${gate.passed ? "passed" : "failed"}`} key={gate.id}><summary><span>{gate.passed ? <Check size={13} /> : <X size={13} />}{gate.gateType}</span><small>{gate.passed ? "passed" : `${gate.failures.length} failure(s)`}</small><ChevronRight className="tool-chevron" size={13} /></summary><div><p className="gate-evaluator">{gate.evaluator === "llm" ? `LLM evaluation · ${gate.evaluatorModel}` : "System invariant"} · {gate.summary}</p>{gate.criterionCoverage?.length ? <div className="criterion-list">{gate.criterionCoverage.map((criterion) => <div className={`criterion-row ${criterion.status}`} key={criterion.criterion}><strong>{criterion.status}</strong><p>{criterion.criterion}</p><small>{criterion.reason}{criterion.evidenceRefs.length ? ` · ${criterion.evidenceRefs.join(", ")}` : ""}</small></div>)}</div> : null}{gate.failures.map((failure) => <div className="gate-detail" key={`${failure.kind}:${failure.key}`}><span>{failure.disposition.replaceAll("_", " ")}</span><strong>{failure.key}</strong><p>{failure.reason}</p></div>)}</div></details>)}</div> : <p className="muted">No settled gate evaluation yet. Standards above show what the Supervisor will review.</p>}
    {failedGates.length > 0 && <small className="audit-footnote">Latest evaluation contains {failedGates.length} failed gate{failedGates.length === 1 ? "" : "s"}; the latest Supervisor decision determines the next action.</small>}
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
  const operation = deriveCurrentOperation(run, now);
  return <section className={`panel-section current-operation ${operation.state}`}>
    <div className="section-title"><span>Current operation</span><small>{operation.state}</small></div>
    <div className="checkpoint-card">
      <strong>{operation.toolName || "agent"}</strong>
    </div>
  </section>;
}

function ContextManifestPanel({ run }: { run: TaskRun }) {
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

function ArtifactsPanel({ run }: { run: TaskRun }) {
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

function RunDetails({ run, toolEvents, transcriptTools, onRefresh }: { run: TaskRun; toolEvents: RunEvent[]; transcriptTools: Extract<TranscriptItem, { kind: "tool" }>[]; onRefresh?: () => Promise<void> }) {
  return <div className="run-details">
    <CurrentOperationPanel run={run} />
    <section className="run-summary"><div className="phase-line"><span className={`phase-badge ${run.status}`}>{run.status}</span><span>{run.phase}</span><span>attempt {run.attempt}</span></div><p>{run.goal}</p>{run.contract && <div className="run-contract"><span>{run.contract.intent.replaceAll("_", " ")} · {run.contract.relation}</span><small>{run.contract.decisionReason}</small><ul>{run.contract.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul></div>}<div className="run-metrics"><span>{run.transcriptCount} messages</span><span>{run.usage.totalTokens.toLocaleString()} tokens</span><span>{run.usage.input.toLocaleString()} in / {run.usage.output.toLocaleString()} out</span><span>token usage is observational only</span></div>{run.blockedReason && <div className="blocked-note">{run.blockedReason}</div>}</section>
    {run.checkpoint && <section className="panel-section"><div className="section-title"><span>Checkpoint</span><small>{run.checkpoint.active ? "active" : "preserved"}</small></div><div className="checkpoint-card"><span>event {run.checkpoint.lastEventSeq} · transcript {run.checkpoint.lastTranscriptSeq}</span>{run.checkpoint.currentTool && <strong>{run.checkpoint.currentTool.toolName}</strong>}{run.checkpoint.assistantPartial && <p>{run.checkpoint.assistantPartial.slice(-240)}</p>}</div></section>}
    <section className="panel-section supervisor-audit-section"><div className="section-title"><span>Supervisor review</span><small>{run.supervision.latestDecision?.action.replaceAll("_", " ") ?? "observing"}</small></div><div className="supervisor-verdict">{run.supervision.latestDecision ? <><div><Eye size={15} /><strong>{run.supervision.latestDecision.reasonCode.replaceAll("_", " ")}</strong><span>{run.supervision.latestDecision.evaluator === "llm" ? `LLM · ${run.supervision.latestDecision.evaluatorModel}` : "System invariant"} · {Math.round(run.supervision.latestDecision.confidence * 100)}% confidence · attempt {run.supervision.latestDecision.attempt}</span></div><p>{run.supervision.latestDecision.rationale}</p></> : <><div><Eye size={15} /><strong>Observing execution</strong></div><p>No intervention decision has been persisted. The Supervisor is monitoring progress and will review the settled candidate against the standards below.</p></>}{run.supervision.progress && <div className="progress-audit"><span>{run.supervision.progress.meaningfulChanges} meaningful changes</span><span>{run.supervision.progress.consecutiveFailures} consecutive failures</span><span>{run.supervision.progress.repeatedOperations} repeated operations</span></div>}</div></section>
    <GateAuditPanel run={run} />
    <ToolActivityPanel transcriptItems={transcriptTools} events={toolEvents} />
    <ContextManifestPanel run={run} />
    {run.supervision.approvalRequests.length > 0 && <section className="panel-section"><div className="section-title"><span>Approvals</span><small>{run.supervision.approvalRequests.filter((item) => item.status === "pending").length} pending</small></div><div className="task-list">{run.supervision.approvalRequests.map((approval) => <div className="approval-row-inline" key={approval.id}><div><strong>{approval.reason}</strong><small>{approval.status}{approval.resolution ? ` · ${approval.resolution}` : ""}</small></div>{approval.status === "pending" && <span className="proposal-actions"><button onClick={async () => { await api.approveRunApproval(approval.id); await onRefresh?.(); }}>Approve & resume</button><button onClick={async () => { await api.rejectRunApproval(approval.id); await onRefresh?.(); }}>Reject</button></span>}</div>)}</div></section>}
    <section className="panel-section"><div className="section-title"><span>Plan</span><small>{run.plan.filter((item) => item.status === "done").length}/{run.plan.length}</small></div><div className="task-list">{run.plan.length ? run.plan.map((item) => <div className="task-row" key={item.key}>{item.status === "done" ? <Check size={15} /> : <Circle size={14} />}<span>{item.title}</span><small>{item.status}</small></div>) : <p className="muted">No structured plan.</p>}</div></section>
    <section className="panel-section"><div className="section-title"><span>Checks</span><small>{run.checks.filter((item) => item.status === "passed" && !item.stale).length}/{run.checks.length}</small></div><div className="task-list">{run.checks.length ? run.checks.map((check) => <div className="task-row" key={check.key}>{check.status === "passed" && !check.stale ? <Check size={15} /> : <Circle size={14} />}<span>{check.title}</span><small>{check.stale ? "stale" : check.status}</small></div>) : <p className="muted">No required checks.</p>}</div></section>
    <section className="panel-section"><div className="section-title"><span>Continuations</span><small>{run.continuations.length}</small></div><div className="task-list">{run.continuations.length ? run.continuations.map((item) => <div className="continuation-row" key={item.id}><div><strong>#{item.ordinal}</strong><span>{item.reason}</span></div><small className={`continuation-status ${item.status}`}>{item.status}{item.leaseUntil && item.status === "running" ? " · leased" : ""}</small></div>) : <p className="muted">No automatic continuation.</p>}</div></section>
    <ArtifactsPanel run={run} />
  </div>;
}

interface QueuePromptProps {
  item: SessionInboxItem; index: number; editing: boolean; draft: string; busy: boolean; starting: boolean; dragging: boolean; canMoveUp: boolean; canMoveDown: boolean;
  onEdit: () => void; onDraftChange: (value: string) => void; onSave: () => void; onCancelEdit: () => void; onStart: () => void; onToggleDefer: () => void; onMergeFirst: () => void; onDelete: () => void; onMoveUp: () => void; onMoveDown: () => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void; onDragEnd: () => void; onDrop: (event: DragEvent<HTMLElement>) => void;
}

function QueuePrompt({ item, index, editing, draft, busy, starting, dragging, canMoveUp, canMoveDown, onEdit, onDraftChange, onSave, onCancelEdit, onStart, onToggleDefer, onMergeFirst, onDelete, onMoveUp, onMoveDown, onDragStart, onDragEnd, onDrop }: QueuePromptProps) {
  return <article className={`inbox-item ${dragging ? "dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={onDrop}>
    <button className="queue-drag-handle" draggable={!busy && !editing} onDragStart={onDragStart} onDragEnd={onDragEnd} disabled={busy || editing} aria-label={`Drag prompt ${index + 1} to reorder`} title="Drag to reorder"><GripVertical size={14} /></button>
    <span className="inbox-position">{index + 1}</span>
    <div>{editing ? <textarea className="queue-editor" value={draft} onChange={(event) => onDraftChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") onCancelEdit(); if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) onSave(); }} autoFocus rows={2} aria-label="Edit queued prompt" /> : <><strong>{item.analysis.summary || item.content}</strong>{item.analysis.summary !== item.content && <p className="inbox-source">{item.content}</p>}</>}<div className="inbox-routing"><span className={`intent-badge ${item.analysis.intent}`}>{item.analysis.intent.replaceAll("_", " ")}</span><span>{item.analysis.urgency} · priority {item.analysis.priority}</span><span>{Math.round(item.analysis.confidence * 100)}% confidence</span>{item.analysis.targetRunId && <span>→ run {item.analysis.targetRunId.slice(0, 8)}</span>}</div><small>{item.decision === "defer" ? "Deferred by user override" : item.analysis.reason}</small>{item.analysis.acceptanceCriteria.length > 0 && <details className="inbox-contract"><summary>Acceptance criteria</summary><ul>{item.analysis.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul></details>}
      <span className="inbox-actions">{editing ? <><button onClick={onSave} disabled={busy || !draft.trim()}>Save</button><button onClick={onCancelEdit} disabled={busy}>Cancel</button></> : <><button onClick={onEdit} disabled={busy}><Pencil size={12} /> Edit</button><button className="run-now" onClick={onStart} disabled={busy}>{starting ? "Starting…" : "Run now"}</button><button onClick={onToggleDefer} disabled={busy}>{item.decision === "defer" ? "Resume" : "Defer"}</button>{index > 0 && <button onClick={onMergeFirst} disabled={busy}>Merge first</button>}<button onClick={onMoveUp} disabled={busy || !canMoveUp} aria-label={`Move queued prompt ${index + 1} up`}>Move up</button><button onClick={onMoveDown} disabled={busy || !canMoveDown} aria-label={`Move queued prompt ${index + 1} down`}>Move down</button></>}</span>
    </div>
    <button onClick={onDelete} disabled={busy} aria-label="Remove queued input"><X size={14} /></button>
  </article>;
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [learningSettings, setLearningSettings] = useState<LearningFeatureState | null>(null);
  const [learningToggleBusy, setLearningToggleBusy] = useState(false);
  const [retryingRunId, setRetryingRunId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [renamingSessionId, setRenamingSessionId] = useState("");
  const [sessionTitleDraft, setSessionTitleDraft] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [pendingUserMessage, setPendingUserMessage] = useState<{ sessionId: string; content: string; createdAt: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submittingUserInputId, setSubmittingUserInputId] = useState("");
  const [activeRun, setActiveRun] = useState<TaskRun | null>(null);
  const [selectedRun, setSelectedRun] = useState<TaskRun | null>(null);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [expandedRunId, setExpandedRunId] = useState("");
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [draft, setDraft] = useState("");
  const [inbox, setInbox] = useState<SessionInboxItem[]>([]);
  const [startingInboxId, setStartingInboxId] = useState("");
  const [editingInboxId, setEditingInboxId] = useState("");
  const [inboxDraft, setInboxDraft] = useState("");
  const [savingInboxId, setSavingInboxId] = useState("");
  const [draggingInboxId, setDraggingInboxId] = useState("");
  const [reorderingInbox, setReorderingInbox] = useState(false);
  const [mutatingInboxId, setMutatingInboxId] = useState("");
  const [streaming, setStreaming] = useState("");
  const [liveThinking, setLiveThinking] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(() => storedBoolean("tagent.left-rail-collapsed"));
  const [rightCollapsed, setRightCollapsed] = useState(() => storedBoolean("tagent.right-panel-collapsed"));
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [workspaceEmojiById, setWorkspaceEmojiById] = useState<Record<string, string>>(storedWorkspaceEmojis);
  const [emojiPickerSessionId, setEmojiPickerSessionId] = useState("");
  const [savingExecutionProfile, setSavingExecutionProfile] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [learningOpen, setLearningOpen] = useState(false);
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [memoryJobs, setMemoryJobs] = useState<CaptureJob[]>([]);
  const [memoryJobsLoaded, setMemoryJobsLoaded] = useState(false);
  const messageScrollRef = useRef<HTMLElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const forceScrollRef = useRef(true);
  const cancelRenameRef = useRef(false);
  const renameSubmittingRef = useRef(false);
  const activeRunIdRef = useRef("");
  const activeRunRef = useRef<TaskRun | null>(null);
  const sessionIdRef = useRef("");
  const replaceStreamingOnNextDeltaRef = useRef(false);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { activeRunIdRef.current = activeRun?.id ?? ""; activeRunRef.current = activeRun; }, [activeRun]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "36px";
    const height = Math.min(Math.max(textarea.scrollHeight, 36), 140);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > 140 ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => {
    try { globalThis.localStorage?.setItem("tagent.left-rail-collapsed", String(leftCollapsed)); } catch { /* Browser storage is optional. */ }
  }, [leftCollapsed]);
  useEffect(() => {
    try { globalThis.localStorage?.setItem("tagent.right-panel-collapsed", String(rightCollapsed)); } catch { /* Browser storage is optional. */ }
  }, [rightCollapsed]);
  useEffect(() => {
    try { globalThis.localStorage?.setItem("tagent.workspace-emojis", JSON.stringify(workspaceEmojiById)); } catch { /* Browser storage is optional. */ }
  }, [workspaceEmojiById]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#171715" : "#f5f4f2");
    try { globalThis.localStorage?.setItem("tagent.theme", theme); } catch { /* Browser storage is optional. */ }
  }, [theme]);

  const loadSessions = useCallback(async () => {
    let items = await api.sessions();
    if (!items.length) items = [await api.createSession("First workspace")];
    setSessions(items);
    setSessionId((current) => current || items[0].id);
  }, []);

  useEffect(() => { void loadSessions(); void api.status().then(setRuntimeStatus); void api.learningSettings().then(setLearningSettings); }, [loadSessions]);
  const toggleLearningAutoExecution = async () => {
    if (!learningSettings || learningToggleBusy) return;
    setLearningToggleBusy(true); setError(""); setNotice("");
    try { const updated = await api.updateLearningSettings({ autoExecutionEnabled: !learningSettings.autoExecutionEnabled }); setLearningSettings(updated); setNotice(updated.autoExecutionEnabled ? "Learning execution participation enabled. Every active action still requires human approval." : "Learning is now passive-only: observe, learn, distill and evolve candidates without active application."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLearningToggleBusy(false); }
  };
  useEffect(() => {
    if (!runtimeStatus?.memoryEnabled || !sessionId) { setMemoryJobs([]); setMemoryJobsLoaded(false); return; }
    setMemoryJobsLoaded(false);
    let closed = false;
    let polling = false;
    const scope = { type: "workspace" as const, id: runtimeStatus.memoryWorkspaceScopeId ?? "default" };
    const refresh = async () => {
      if (closed || polling) return;
      polling = true;
      try { const jobs = await api.memoryJobs(scope); if (!closed) { setMemoryJobs(jobs); setMemoryJobsLoaded(true); } }
      catch { if (!closed) setMemoryJobsLoaded(true); }
      finally { polling = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3_000);
    return () => { closed = true; clearInterval(timer); };
  }, [runtimeStatus?.memoryEnabled, runtimeStatus?.memoryWorkspaceScopeId, sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    const targetSessionId = sessionId;
    let closed = false;
    let polling = false;
    const refresh = async () => {
      if (closed || polling) return;
      polling = true;
      try {
        const [queued, runHistory, sessionItems] = await Promise.all([
          api.inbox(targetSessionId), api.runs(targetSessionId), api.sessions(),
        ]);
        if (closed || sessionIdRef.current !== targetSessionId) return;
        setInbox(queued);
        setRuns(runHistory);
        setSessions(sessionItems);
        const active = runHistory.find((item) => ["running", "waiting_input", "blocked", "interrupted"].includes(item.status)) ?? null;
        if (active?.id && active.id !== activeRunIdRef.current) {
          const [hydrated, view, history] = await Promise.all([api.run(active.id), api.transcriptView(active.id), api.messages(targetSessionId)]);
          if (closed || sessionIdRef.current !== targetSessionId) return;
          replaceStreamingOnNextDeltaRef.current = false;
          setMessages(history); setHasOlderMessages(history.length === 80);
          setActiveRun(hydrated); setSelectedRun(hydrated); setExpandedRunId(hydrated.id);
          setTranscript(view); setStreaming(hydrated.checkpoint?.active ? hydrated.checkpoint.assistantPartial : ""); setLiveThinking("");
          setEvents(hydrated.checkpoint?.active && hydrated.checkpoint.currentTool ? [{ runId: hydrated.id, seq: hydrated.checkpoint.lastEventSeq, type: "tool.started", data: hydrated.checkpoint.currentTool, createdAt: hydrated.checkpoint.updatedAt }] : []);
          setError("");
        } else if (!active && activeRunIdRef.current) {
          const endedRunId = activeRunIdRef.current;
          const [history, ended, view] = await Promise.all([api.messages(targetSessionId), api.run(endedRunId), api.transcriptView(endedRunId)]);
          if (closed || sessionIdRef.current !== targetSessionId || activeRunIdRef.current !== endedRunId) return;
          replaceStreamingOnNextDeltaRef.current = false;
          setMessages(history); setHasOlderMessages(history.length === 80); setSelectedRun(ended); setTranscript(view);
          setActiveRun(null); setStreaming(""); setLiveThinking(""); setEvents([]);
        } else if (active) {
          const currentRun = activeRunIdRef.current === active.id ? await api.run(active.id) : active;
          const shouldRefreshContent = currentRun.lastEventSeq !== activeRunRef.current?.lastEventSeq;
          if (shouldRefreshContent) {
            const [view, history] = await Promise.all([api.transcriptView(active.id), api.messages(targetSessionId)]);
            if (closed || sessionIdRef.current !== targetSessionId) return;
            setTranscript(view); setMessages(history); setHasOlderMessages(history.length === 80);
          }
          setActiveRun(currentRun);
          setSelectedRun((current) => current?.id === currentRun.id ? currentRun : current);
        }
      } catch {
        // SSE remains authoritative while polling provides eventual UI recovery.
      } finally { polling = false; }
    };
    const timer = setInterval(() => void refresh(), 5000);
    return () => { closed = true; clearInterval(timer); };
  }, [sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    const targetSessionId = sessionId;
    let closed = false;
    replaceStreamingOnNextDeltaRef.current = false;
    setStreaming(""); setLiveThinking(""); setEvents([]); setError(""); setEditingInboxId(""); setInboxDraft(""); setDraggingInboxId(""); setPendingUserMessage(null);
    void Promise.all([api.messages(targetSessionId), api.runs(targetSessionId), api.inbox(targetSessionId)]).then(async ([history, runHistory, queued]) => {
      if (closed || sessionIdRef.current !== targetSessionId) return;
      const latest = runHistory[0] ?? null;
      const active = runHistory.find((item) => ["running", "waiting_input", "blocked", "interrupted"].includes(item.status)) ?? null;
      setMessages(history); setHasOlderMessages(history.length === 80); setRuns(runHistory); setInbox(queued); setActiveRun(active); setSelectedRun(latest); setExpandedRunId(latest?.id ?? "");
      setStreaming(active?.checkpoint?.active ? active.checkpoint.assistantPartial : ""); setLiveThinking("");
      setEvents(active?.checkpoint?.active && active.checkpoint.currentTool ? [{ runId: active.id, seq: active.checkpoint.lastEventSeq, type: "tool.started", data: active.checkpoint.currentTool, createdAt: active.checkpoint.updatedAt }] : []);
      if (!latest) { setTranscript([]); return; }
      const view = await api.transcriptView(latest.id);
      if (!closed && sessionIdRef.current === targetSessionId) setTranscript(view);
    }).catch((cause) => { if (!closed && sessionIdRef.current === targetSessionId) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { closed = true; };
  }, [sessionId]);

  const [streamGeneration, setStreamGeneration] = useState(0);
  useEffect(() => {
    const reconnect = () => { if (document.visibilityState === "visible" && navigator.onLine) setStreamGeneration((value) => value + 1); };
    document.addEventListener("visibilitychange", reconnect);
    window.addEventListener("online", reconnect);
    return () => { document.removeEventListener("visibilitychange", reconnect); window.removeEventListener("online", reconnect); };
  }, []);
  useEffect(() => {
    if (!activeRun?.id || !["running", "waiting_input", "blocked", "interrupted"].includes(activeRun.status)) return;
    let closed = false;
    let unsubscribe: () => void = () => {};
    const consumerKey = "tagent.eventConsumerId";
    let consumerId = localStorage.getItem(consumerKey);
    if (!consumerId) { consumerId = `web-${createRequestId()}`; localStorage.setItem(consumerKey, consumerId); }
    const runId = activeRun.id;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    let highestAckSeq = 0;
    let ackGeneration = 0;
    const flushAck = () => {
      if (closed || !highestAckSeq || !ackGeneration) return;
      const seq = highestAckSeq;
      highestAckSeq = 0;
      void api.ackConsumer(runId, consumerId!, ackGeneration, seq).catch(() => undefined);
    };
    const scheduleAck = (seq: number) => {
      highestAckSeq = Math.max(highestAckSeq, seq);
      if (ackTimer) return;
      ackTimer = setTimeout(() => { ackTimer = undefined; flushAck(); }, 500);
    };
    const checkpointAfter = activeRun.checkpoint?.active ? activeRun.checkpoint.lastEventSeq : activeRun.lastEventSeq ?? 0;
    void api.claimConsumer(runId, consumerId).then((cursor) => {
      ackGeneration = cursor.generation;
      if (closed) return;
      setError("");
      const after = Math.max(checkpointAfter, cursor.ackedSeq);
      unsubscribe = subscribe(runId, consumerId, cursor.generation, after, async (event) => {
      setEvents((current) => [...current.slice(-39), event]);
      if (event.type === "message.started") { replaceStreamingOnNextDeltaRef.current = true; setLiveThinking(""); }
      if (event.type === "message.thinking.delta") setLiveThinking((current) => current + String(event.data.delta ?? ""));
      if (event.type === "message.delta") setStreaming((current) => {
        const delta = String(event.data.delta ?? "");
        if (replaceStreamingOnNextDeltaRef.current) {
          replaceStreamingOnNextDeltaRef.current = false;
          return delta;
        }
        return current + delta;
      });
      if (event.type === "message.completed") {
        const content = String(event.data.content ?? "");
        if (content.trim()) { replaceStreamingOnNextDeltaRef.current = false; setStreaming(content); }
      }
      if (event.type === "transcript.updated") {
        const view = await api.transcriptView(runId);
        if (closed || sessionIdRef.current !== sessionId) return;
        setTranscript(view); setStreaming(""); setLiveThinking("");
      }
      if (["run.completed", "run.blocked", "run.failed", "run.cancelled", "run.waiting_for_input"].includes(event.type)) {
        const [updated, runHistory, history, queued, view, sessionItems] = await Promise.all([
          api.run(runId), api.runs(sessionId), api.messages(sessionId), api.inbox(sessionId), api.transcriptView(runId), api.sessions(),
        ]);
        if (closed || sessionIdRef.current !== sessionId) return;
        const nextActive = runHistory.find((item) => ["running", "waiting_input", "blocked", "interrupted"].includes(item.status)) ?? null;
        setStreaming((current) => {
          const response = String(event.data.response ?? "").trim();
          const persisted = !current.trim() || history.some((message) => message.role === "assistant" && (message.content === current || (response && message.content === response)));
          return persisted ? "" : current;
        });
        replaceStreamingOnNextDeltaRef.current = false; setActiveRun(nextActive);
        setSelectedRun(updated);
        setRuns(runHistory); setMessages((current) => {
          const older = current.filter((message) => !history.some((latest) => latest.id === message.id) && message.id < (history[0]?.id ?? Number.MAX_SAFE_INTEGER));
          return [...older, ...history];
        }); setInbox(queued); setTranscript(view); setSessions(sessionItems);
      } else if (event.type === "run.updated" || event.type.startsWith("continuation.") || event.type.startsWith("supervisor.")) {
        const updated = await api.run(runId);
        if (closed || sessionIdRef.current !== sessionId) return;
        setActiveRun(updated);
        setSelectedRun((current) => current?.id === updated.id ? updated : current);
        setRuns((current) => current.map((item) => item.id === updated.id ? updated : item));
      }
      if (!closed) scheduleAck(event.seq);
      }, () => {
        if (closed) return;
        unsubscribe();
        window.setTimeout(() => { if (!closed && document.visibilityState === "visible" && navigator.onLine) setStreamGeneration((value) => value + 1); }, 1_000);
      });
    }).catch((cause) => { if (!closed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { flushAck(); closed = true; if (ackTimer) clearTimeout(ackTimer); unsubscribe(); };
  }, [activeRun?.id, activeRun?.status, sessionId, loadSessions, streamGeneration]);

  useEffect(() => {
    const viewport = messageScrollRef.current;
    if (!viewport || (!autoScrollRef.current && !forceScrollRef.current)) return;
    viewport.scrollTop = viewport.scrollHeight;
    forceScrollRef.current = false;
  }, [messages, pendingUserMessage, transcript, streaming, liveThinking, events]);

  const handleMessageScroll = useCallback(() => {
    const viewport = messageScrollRef.current;
    if (!viewport) return;
    autoScrollRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 96;
  }, []);

  const activeTools = useMemo(() => events.filter((event) => event.type.startsWith("tool.")).slice(-20), [events]);
  const transcriptTools = useMemo(() => transcript.filter((item): item is Extract<TranscriptItem, { kind: "tool" }> => item.kind === "tool"), [transcript]);
  const memoryJobByMessageId = useMemo(() => {
    const jobs = new Map<number, CaptureJob>();
    for (const job of memoryJobs) {
      if (job.request.captureSource?.kind && job.request.captureSource.kind !== "user_message") continue;
      for (const source of job.request.sourceRefs) {
        if (source.sourceType !== "message") continue;
        const messageId = Number(source.sourceId);
        if (Number.isFinite(messageId) && (!jobs.has(messageId) || job.updatedAt > (jobs.get(messageId)?.updatedAt ?? 0))) jobs.set(messageId, job);
      }
    }
    return jobs;
  }, [memoryJobs]);

  async function loadOlderMessages() {
    if (!sessionId || loadingOlderMessages || !messages.length) return;
    const viewport = messageScrollRef.current;
    const previousHeight = viewport?.scrollHeight ?? 0;
    setLoadingOlderMessages(true);
    try {
      const older = await api.messages(sessionId, 80, messages[0].id);
      setMessages((current) => [...older.filter((item) => !current.some((existing) => existing.id === item.id)), ...current]);
      setHasOlderMessages(older.length === 80);
      requestAnimationFrame(() => { if (viewport) viewport.scrollTop += viewport.scrollHeight - previousHeight; });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoadingOlderMessages(false); }
  }

  async function createSession() {
    const session = await api.createSession(`Workspace ${sessions.length + 1}`);
    setSessions((current) => [session, ...current]); setSessionId(session.id); setLeftOpen(false);
  }

  function cancelRename() {
    cancelRenameRef.current = true;
    setRenamingSessionId(""); setSessionTitleDraft("");
  }

  async function renameSession(session: Session) {
    if (cancelRenameRef.current) { cancelRenameRef.current = false; return; }
    if (renameSubmittingRef.current) return;
    const title = sessionTitleDraft.trim();
    if (!title) { setError("Workspace name is required."); return; }
    if (title === session.title) { setRenamingSessionId(""); setSessionTitleDraft(""); return; }
    renameSubmittingRef.current = true;
    setError("");
    try {
      const updated = await api.renameSession(session.id, title);
      setSessions((current) => current.map((item) => item.id === updated.id ? updated : item));
      setRenamingSessionId(""); setSessionTitleDraft("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { renameSubmittingRef.current = false; }
  }

  async function updateExecutionProfile(settings: { modelId?: string; reasoningEffort?: Session["reasoningEffort"] }) {
    if (!sessionId || savingExecutionProfile) return;
    setSavingExecutionProfile(true); setError(""); setNotice("");
    try {
      const updated = await api.updateSession(sessionId, settings);
      setSessions((current) => current.map((item) => item.id === updated.id ? updated : item));
      setNotice(activeRun ? "Execution preference saved for the next TaskRun; the active TaskRun keeps its original profile." : "Workspace execution preference saved.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSavingExecutionProfile(false); }
  }

  async function submit() {
    const content = draft.trim();
    const targetSessionId = sessionId;
    if (!content || !targetSessionId || submitting) return;
    const optimistic = { sessionId: targetSessionId, content, createdAt: Date.now() };
    setSubmitting(true); setDraft(""); setError(""); setNotice(""); forceScrollRef.current = true;
    try {
      const admission = await api.send(targetSessionId, content);
      if (sessionIdRef.current !== targetSessionId) return;
      if (admission.run) setPendingUserMessage(optimistic);
      const [queued, history] = await Promise.all([api.inbox(targetSessionId), api.messages(targetSessionId)]);
      if (sessionIdRef.current !== targetSessionId) return;
      const persisted = history.some((message) => message.role === "user" && message.content === content && message.createdAt >= optimistic.createdAt - 5_000);
      setInbox(queued); setMessages(history); setHasOlderMessages(history.length === 80); setPendingUserMessage(persisted ? null : admission.run ? optimistic : null);
      if (admission.run) {
        const nextRun = admission.run;
        setActiveRun(nextRun); setSelectedRun(nextRun); setRuns((current) => [nextRun, ...current.filter((item) => item.id !== nextRun.id)]); setExpandedRunId(nextRun.id); setEvents([]); setTranscript([]); setStreaming(""); setLiveThinking("");
      }
    } catch (cause) {
      if (sessionIdRef.current === targetSessionId) { setPendingUserMessage(null); setDraft(content); setError(cause instanceof Error ? cause.message : String(cause)); }
    } finally { setSubmitting(false); }
  }

  async function saveInbox(item: SessionInboxItem) {
    const content = inboxDraft.trim();
    if (!content || savingInboxId) return;
    setSavingInboxId(item.id); setError(""); setNotice("");
    try { await api.updateInbox(sessionId, item.id, content); setInbox(await api.inbox(sessionId)); setEditingInboxId(""); setInboxDraft(""); setNotice("Queued prompt updated."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSavingInboxId(""); }
  }

  async function applyInboxOrder(next: SessionInboxItem[]) {
    setReorderingInbox(true); setError(""); setNotice("");
    try { setInbox(await api.reorderInbox(sessionId, next.map((item) => item.id))); setNotice("Queued prompts reordered."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setInbox(await api.inbox(sessionId).catch(() => inbox)); }
    finally { setReorderingInbox(false); setDraggingInboxId(""); }
  }

  async function reorderInbox(targetId: string) {
    if (!draggingInboxId || draggingInboxId === targetId || reorderingInbox || mutatingInboxId) return;
    const from = inbox.findIndex((item) => item.id === draggingInboxId); const to = inbox.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...inbox]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved);
    await applyInboxOrder(next);
  }

  async function moveInbox(itemId: string, offset: -1 | 1) {
    if (reorderingInbox || mutatingInboxId) return;
    const from = inbox.findIndex((item) => item.id === itemId); const to = from + offset;
    if (from < 0 || to < 0 || to >= inbox.length) return;
    const next = [...inbox]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved);
    await applyInboxOrder(next);
  }

  async function mutateInbox(itemId: string, operation: () => Promise<unknown>, noticeText?: string) {
    if (mutatingInboxId || reorderingInbox || startingInboxId || savingInboxId) return;
    setMutatingInboxId(itemId); setError(""); setNotice("");
    try { await operation(); setInbox(await api.inbox(sessionId)); if (noticeText) setNotice(noticeText); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setMutatingInboxId(""); }
  }

  async function runInboxNow(item: SessionInboxItem) {
    if (!sessionId || startingInboxId) return;
    setStartingInboxId(item.id); setError(""); setNotice("");
    try {
      if (activeRun?.status === "running" && item.analysis.relation === "parallel" && item.analysis.targetRunId === activeRun.id) {
        await api.requestParallelStart(sessionId, item.id);
        setNotice("Parallel start sent to the human approval queue. The task remains queued until approval and explicit execution.");
        return;
      }
      const result = await api.startInbox(sessionId, item.id);
      const nextRun = result.run;
      setInbox(await api.inbox(sessionId)); const history = await api.messages(sessionId); setMessages(history); setHasOlderMessages(history.length === 80); setActiveRun(nextRun); setSelectedRun(nextRun);
      setRuns((current) => [nextRun, ...current.filter((run) => run.id !== nextRun.id)]); setExpandedRunId(nextRun.id); setEvents([]); setTranscript([]); setStreaming(""); setLiveThinking("");
      setNotice("Queued prompt started.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setStartingInboxId(""); }
  }

  async function submitRequestedInput(request: UserInputRequest, values: Record<string, string>) {
    if (submittingUserInputId) return;
    setSubmittingUserInputId(request.id); setError(""); setNotice("");
    try {
      const resumed = await api.submitUserInput(request.id, values);
      setActiveRun(resumed); setSelectedRun(resumed); setRuns((current) => current.map((item) => item.id === resumed.id ? resumed : item));
      setEvents([]); setStreaming(""); setLiveThinking(""); setNotice("Information submitted. TaskRun resumed."); forceScrollRef.current = true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSubmittingUserInputId(""); }
  }

  async function retryLaunch(run: TaskRun) {
    if (retryingRunId) return;
    setRetryingRunId(run.id); setError(""); setNotice("");
    try {
      const result = await api.retryLaunch(run.id);
      const nextRun = result.run;
      setActiveRun(nextRun); setSelectedRun(nextRun); setRuns((current) => [nextRun, ...current.filter((item) => item.id !== nextRun.id)]); setExpandedRunId(nextRun.id); setTranscript([]); setStreaming(""); setLiveThinking("");
      setNotice("TaskRun launch retry started.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRetryingRunId(""); }
  }

  const selectedSession = sessions.find((session) => session.id === sessionId);
  const selectableModels = [...new Set([runtimeStatus?.modelId ?? "gpt-5.6-sol", ...(runtimeStatus?.fallbackModelIds ?? [])])];

  return <div className={`app-shell ${leftCollapsed ? "left-collapsed" : ""} ${rightCollapsed ? "right-collapsed" : ""}`}>
    <aside className={`session-rail ${leftOpen ? "mobile-open" : ""} ${leftCollapsed ? "collapsed" : ""}`}>
      <div className="brand"><div className="brand-mark"><Bot size={18} /></div><div className="brand-copy"><strong>TAgent</strong><span>Core runtime</span></div><button className="icon-button desktop-only rail-collapse" onClick={() => setLeftCollapsed((current) => !current)} aria-label={leftCollapsed ? "Expand workspace sidebar" : "Collapse workspace sidebar"} title={leftCollapsed ? "Expand sidebar" : "Collapse sidebar"}>{leftCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button><button className="icon-button mobile-only" onClick={() => setLeftOpen(false)} aria-label="Close sessions"><X size={18} /></button></div>
      <button className="new-session" onClick={createSession} title="New workspace"><Plus size={16} /><span>New workspace</span></button>
      <div className="session-list">
        {sessions.map((session) => <div key={session.id} className={`session-item ${session.id === sessionId ? "active" : ""}`}>
          <button className="session-emoji" type="button" aria-label={`Choose emoji for ${session.title}`} aria-expanded={emojiPickerSessionId === session.id} onClick={() => setEmojiPickerSessionId((current) => current === session.id ? "" : session.id)}>{workspaceEmojiById[session.id] ?? "💬"}</button>
          {emojiPickerSessionId === session.id && <div className="emoji-picker" role="listbox" aria-label={`Emoji for ${session.title}`}>{workspaceEmojis.map((emoji) => <button type="button" role="option" aria-selected={(workspaceEmojiById[session.id] ?? "💬") === emoji} key={emoji} onClick={() => { setWorkspaceEmojiById((current) => ({ ...current, [session.id]: emoji })); setEmojiPickerSessionId(""); }}>{emoji}</button>)}</div>}
          {renamingSessionId === session.id ? <div className="session-select session-editor">
            <span><input className="session-title-input" value={sessionTitleDraft} autoFocus onChange={(event) => setSessionTitleDraft(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); void renameSession(session); }
              if (event.key === "Escape") { event.preventDefault(); cancelRename(); event.currentTarget.blur(); }
            }} onBlur={() => void renameSession(session)} aria-label="Workspace name" /><span className="session-meta"><small>{formatTime(session.updatedAt)}</small><WorkspaceRunStatus session={session} /></span></span>
          </div> : <>
            <button className="session-select" onClick={() => { setSessionId(session.id); setLeftOpen(false); setEmojiPickerSessionId(""); }}><span><strong>{session.title}</strong><span className="session-meta"><small>{formatTime(session.updatedAt)}</small><WorkspaceRunStatus session={session} /></span></span></button>
            <button className="rename-session" onClick={() => { setRenamingSessionId(session.id); setSessionTitleDraft(session.title); }} title="Rename workspace" aria-label="Rename workspace"><Pencil size={13} /></button>
          </>}
        </div>)}
      </div>
      <div className="rail-footer"><span className="status-dot" />Local control plane{runtimeStatus?.schemaVersion ? ` · db v${runtimeStatus.schemaVersion}` : ""}</div>
    </aside>

    <main className="conversation">
      <header className="topbar">
        <button className="icon-button mobile-only" onClick={() => setLeftOpen(true)} aria-label="Open sessions"><Menu size={19} /></button>
        <div className="workspace-heading"><span className="workspace-kicker">Workspace</span><h1>{selectedSession?.title ?? "TAgent Core"}</h1><p>{activeRun ? `${activeRun.phase} · ${activeRun.status} · ${activeRun.modelId || runtimeStatus?.modelId || "default model"} · ${activeRun.reasoningEffort}` : runtimeStatus ? `${runtimeStatus.runtime} · ready` : "Ready for a new task"}</p></div>
        {selectedSession && <div className="execution-preferences" aria-label="Workspace execution preferences"><label><span>Model</span><select aria-label="Model" value={selectedSession.modelId || runtimeStatus?.modelId || "gpt-5.6-sol"} disabled={savingExecutionProfile} onChange={(event) => void updateExecutionProfile({ modelId: event.target.value })}>{selectableModels.map((modelId) => <option value={modelId} key={modelId}>{modelId}</option>)}</select></label><label><span>Reasoning</span><select aria-label="Reasoning effort" value={selectedSession.reasoningEffort} disabled={savingExecutionProfile} onChange={(event) => void updateExecutionProfile({ reasoningEffort: event.target.value as Session["reasoningEffort"] })}>{reasoningEfforts.map((effort) => <option value={effort} key={effort}>{effort}</option>)}</select></label></div>}
        <div className="top-actions"><button className="icon-button theme-toggle" type="button" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`Use ${theme === "dark" ? "light" : "dark"} theme`}>{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}</button>{learningSettings && <div className={`learning-execution-control ${!learningSettings.memoryEnabled ? "dependency-disabled" : learningSettings.autoExecutionEnabled ? "enabled" : "passive"}`} title={!learningSettings.memoryEnabled ? "Learning requires Memory" : learningSettings.autoExecutionEnabled ? "Learning may participate in execution, but every active action still requires human approval" : "Passive-only: observation, learning, distillation and candidate evolution"}><div><strong>Learning execution</strong><small>{!learningSettings.memoryEnabled ? "Memory required" : learningSettings.autoExecutionEnabled ? "On · approval always required" : "Off · passive learning only"}</small></div><button type="button" role="switch" aria-label="Allow approved learning workflows to participate in execution" aria-checked={learningSettings.autoExecutionEnabled} disabled={!learningSettings.learningEnabled || learningToggleBusy} onClick={() => void toggleLearningAutoExecution()}><span /></button></div>}{sessionId && <button className="memory-launch" onClick={() => setGoalsOpen(true)} aria-label="Open Workspace Goals" title="Workspace Goals"><Target size={16} /><span>Goals</span></button>}{sessionId && <button className="memory-launch" onClick={() => setLearningOpen(true)} disabled={!learningSettings?.learningEnabled} aria-label="Open learning center" title="Learning center"><ShieldCheck size={16} /><span>Learning</span></button>}{runtimeStatus?.memoryEnabled && <button className="memory-launch" onClick={() => setMemoryOpen(true)} aria-label="Open memory center" title="Memory center"><BrainCircuit size={16} /><span>Memory</span><i /></button>}{selectedRun?.resumable && !activeRun && !selectedRun.supervision.approvalRequests.some((item) => item.status === "pending") && <button className="resume-button" onClick={async () => { setError(""); try { const resumed = await api.resume(selectedRun.id); setActiveRun(resumed); setSelectedRun(resumed); setStreaming(""); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}><Play size={15} />Resume</button>}{selectedRun?.status === "failed" && selectedRun.launchRetryable && !activeRun && <button className="resume-button" onClick={() => void retryLaunch(selectedRun)} disabled={Boolean(retryingRunId)}><Play size={15} />{retryingRunId === selectedRun.id ? "Retrying…" : "Retry launch"}</button>}{activeRun?.status === "running" && <button className="icon-button danger" onClick={() => void api.cancel(activeRun.id)} title="Stop run" aria-label="Stop run"><Square size={17} /></button>}<button className="icon-button mobile-only mobile-tools-toggle" type="button" aria-label="Open workspace tools" aria-expanded={mobileToolsOpen} onClick={() => setMobileToolsOpen((current) => !current)}><SlidersHorizontal size={17} /></button><button className="icon-button mobile-only" onClick={() => { setMobileToolsOpen(false); setRightOpen(true); }} aria-label="Open task panel"><PanelRight size={19} /></button>{mobileToolsOpen && <div className="mobile-tools-menu"><button onClick={() => { setTheme((current) => current === "dark" ? "light" : "dark"); setMobileToolsOpen(false); }}>{theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}<span>{theme === "dark" ? "Light theme" : "Dark theme"}</span></button>{sessionId && <button onClick={() => { setGoalsOpen(true); setMobileToolsOpen(false); }}><Target size={15} /><span>Workspace Goals</span></button>}{sessionId && <button onClick={() => { setLearningOpen(true); setMobileToolsOpen(false); }} disabled={!learningSettings?.learningEnabled}><ShieldCheck size={15} /><span>Learning center</span></button>}{runtimeStatus?.memoryEnabled && <button onClick={() => { setMemoryOpen(true); setMobileToolsOpen(false); }}><BrainCircuit size={15} /><span>Memory center</span></button>}{learningSettings && <button onClick={() => void toggleLearningAutoExecution()} disabled={!learningSettings.learningEnabled || learningToggleBusy}><Activity size={15} /><span>Learning execution: {learningSettings.autoExecutionEnabled ? "on" : "off"}</span></button>}</div>}</div>
      </header>

      <section className="message-scroll" ref={messageScrollRef} onScroll={handleMessageScroll}>
        <div className="message-feed">
        {!messages.length && !streaming && pendingUserMessage?.sessionId !== sessionId && <div className="empty-state"><div className="empty-icon"><Sparkles size={23} /></div><span className="empty-kicker">Durable agent workspace</span><h2>Start with the outcome</h2><p>Describe the result you want. TAgent turns it into governed work with durable progress, evidence, and recovery.</p><div className="empty-capabilities" aria-label="TAgent workflow"><span>Plan</span><i /><span>Execute</span><i /><span>Verify</span></div></div>}
        {hasOlderMessages && <button className="load-older" onClick={() => void loadOlderMessages()} disabled={loadingOlderMessages}>{loadingOlderMessages ? "Loading…" : "Load earlier messages"}</button>}
        {messages.map((message) => <ChatMessage key={message.id} message={message} memoryEnabled={Boolean(runtimeStatus?.memoryEnabled)} memoryJob={message.role === "user" ? (memoryJobsLoaded ? memoryJobByMessageId.get(message.id) ?? null : undefined) : undefined} />)}
        {pendingUserMessage?.sessionId === sessionId && !messages.some((message) => message.role === "user" && message.content === pendingUserMessage.content && message.createdAt >= pendingUserMessage.createdAt - 5_000) && <article className="message user pending" aria-label="Sending message"><div className="message-meta"><span>You</span><time>Sending…</time></div><div className="message-body"><Markdown>{pendingUserMessage.content}</Markdown></div>{runtimeStatus?.memoryEnabled && <MemoryExtraction job={undefined} />}</article>}
        {activeRun && <div className="active-run-strip"><Activity size={14} /><span>Attempt {activeRun.attempt}</span><strong>{activeRun.phase}</strong><small>{activeRun.usage.totalTokens.toLocaleString()} tokens</small></div>}
        {selectedRun?.pendingUserInput && <UserInputCard request={selectedRun.pendingUserInput} submitting={submittingUserInputId === selectedRun.pendingUserInput.id} onSubmit={(values) => submitRequestedInput(selectedRun.pendingUserInput!, values)} />}
        {(activeRun || selectedRun) && transcript.length + events.length + Number(Boolean(liveThinking || streaming)) > 0 && <ExecutionTimeline runId={(activeRun ?? selectedRun)!.id} isRunning={activeRun?.status === "running"} items={transcript} events={activeRun ? events : []} liveThinking={activeRun ? liveThinking : ""} liveOutput={activeRun ? streaming : ""} />}
        <div ref={endRef} />
        </div>
      </section>

      <footer className="composer-wrap">
        {error && <div className="error-banner">{error}</div>}
        {notice && <div className="success-banner">{notice}</div>}
        <div className="composer-mode"><span><Activity size={13} />Supervisor inbox</span><span>{activeRun ? "New input is classified as steer, context, follow-up, parallel work, or a new TaskRun" : "Supervisor summarizes, prioritizes, and starts the next eligible contract"}</span></div>
        <div className="composer"><textarea ref={composerTextareaRef} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Add a task, correction, constraint, context update, or follow-up" rows={1} aria-label="Message. Enter inserts a new line; use Send to submit." /><button type="button" onClick={() => void submit()} disabled={!draft.trim() || submitting} aria-label="Add to Supervisor queue">{submitting ? <Activity className="spin" size={18} /> : <Send size={18} />}</button></div>
        {inbox.length > 0 && <section className="supervisor-inbox"><div className="inbox-heading"><span>Up next</span><small>{inbox.length} queued</small></div>{inbox.map((item, index) => <QueuePrompt key={item.id} item={item} index={index} editing={editingInboxId === item.id} draft={editingInboxId === item.id ? inboxDraft : item.content} busy={Boolean(startingInboxId || savingInboxId || reorderingInbox || mutatingInboxId)} starting={startingInboxId === item.id} dragging={draggingInboxId === item.id} canMoveUp={index > 0} canMoveDown={index < inbox.length - 1} onEdit={() => { setEditingInboxId(item.id); setInboxDraft(item.content); setError(""); setNotice(""); }} onDraftChange={setInboxDraft} onSave={() => void saveInbox(item)} onCancelEdit={() => { setEditingInboxId(""); setInboxDraft(""); }} onStart={() => void runInboxNow(item)} onToggleDefer={() => void mutateInbox(item.id, () => api.decideInbox(sessionId, item.id, item.decision === "defer" ? "pending" : "defer"))} onMergeFirst={() => void mutateInbox(item.id, () => api.mergeInbox(sessionId, item.id, inbox[0].id))} onDelete={() => void mutateInbox(item.id, () => api.deleteInbox(sessionId, item.id))} onMoveUp={() => void moveInbox(item.id, -1)} onMoveDown={() => void moveInbox(item.id, 1)} onDragStart={(event) => { setDraggingInboxId(item.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id); }} onDragEnd={() => setDraggingInboxId("")} onDrop={(event) => { event.preventDefault(); void reorderInbox(item.id); }} />)}</section>}
      </footer>
    </main>

    <aside className={`run-panel ${rightOpen ? "mobile-open" : ""} ${rightCollapsed ? "collapsed" : ""}`}>
      <div className="panel-heading"><div><span className="eyebrow">Audit workspace</span><h2>Supervisor & execution</h2></div><button className="icon-button desktop-only panel-collapse" onClick={() => setRightCollapsed((current) => !current)} aria-label={rightCollapsed ? "Expand audit sidebar" : "Collapse audit sidebar"} title={rightCollapsed ? "Expand sidebar" : "Collapse sidebar"}>{rightCollapsed ? <PanelRightOpen size={17} /> : <PanelRightClose size={17} />}</button><button className="icon-button mobile-only" onClick={() => setRightOpen(false)} aria-label="Close task panel"><X size={18} /></button></div>
      {!runs.length ? <div className="panel-empty"><Play size={20} /><p>No TaskRuns</p></div> : <div className="run-history">{runs.map((item, index) => {
        const expanded = item.id === expandedRunId;
        return <section className={`run-history-item ${expanded ? "expanded" : ""}`} key={item.id}>
          <button className="run-history-toggle" onClick={async () => {
            if (expanded) { setExpandedRunId(""); return; }
            const selected = await api.run(item.id); setSelectedRun(selected); setExpandedRunId(item.id); setTranscript(await api.transcriptView(item.id));
          }} aria-expanded={expanded}>
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            <span className={`history-status ${item.status}`} />
            <span className="history-copy"><strong>{item.goal}</strong><small>{item.status} · attempt {item.attempt}</small></span>
            <time>{index === 0 && item.status === "running" ? "current" : formatTime(item.updatedAt ?? item.createdAt)}</time>
          </button>
          {expanded && <RunDetails run={selectedRun?.id === item.id ? selectedRun : item} toolEvents={activeRun?.id === item.id ? activeTools : []} transcriptTools={transcriptTools} onRefresh={async () => { const refreshed = await api.run(item.id); setSelectedRun(refreshed); setRuns((current) => current.map((run) => run.id === refreshed.id ? refreshed : run)); }} />}
        </section>;
      })}</div>}
    </aside>
    {runtimeStatus?.memoryEnabled && memoryOpen && <Suspense fallback={null}><MemoryPanel runtime={runtimeStatus} onClose={() => setMemoryOpen(false)} /></Suspense>}
    {learningOpen && sessionId && learningSettings?.learningEnabled && <Suspense fallback={null}><LearningCenter sessionId={sessionId} onClose={() => setLearningOpen(false)} /></Suspense>}
    {goalsOpen && sessionId && <Suspense fallback={null}><GoalsPanel workspaceId={sessionId} onClose={() => setGoalsOpen(false)} onOpenRun={(runId) => { void api.run(runId).then(async (run) => { setSelectedRun(run); setExpandedRunId(run.id); setTranscript(await api.transcriptView(run.id)); setGoalsOpen(false); setRightOpen(true); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }} /></Suspense>}
    {(leftOpen || rightOpen) && <button className="backdrop mobile-only" onClick={() => { setLeftOpen(false); setRightOpen(false); }} aria-label="Close panel" />}
  </div>;
}
