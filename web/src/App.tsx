import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Bot, Check, ChevronDown, ChevronRight, Circle, Command, FileText, Menu, MessageSquarePlus, PanelRight, Play, Plus, Send, Square, Terminal, X } from "lucide-react";
import { api, subscribe, type Message, type RunEvent, type RuntimeStatus, type Session, type SessionInboxItem, type TaskRun, type TranscriptItem } from "./api";
import { Markdown } from "./Markdown";
import { createRequestId } from "./id";

const formatTime = (value: number) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(value);

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
    <summary><Terminal size={14} /><span>{item.toolName}</span><small>{item.status}</small><ChevronRight className="tool-chevron" size={14} /></summary>
    <div className="tool-call-body"><div><strong>Arguments</strong><pre>{JSON.stringify(item.arguments, null, 2)}</pre></div><div><strong>Result</strong><pre>{item.result || "No result recorded"}</pre></div></div>
  </details>;
}

function RunDetails({ run }: { run: TaskRun }) {
  return <div className="run-details">
    <section className="run-summary"><div className="phase-line"><span className={`phase-badge ${run.status}`}>{run.status}</span><span>{run.phase}</span><span>attempt {run.attempt}</span></div><p>{run.goal}</p><div className="run-metrics"><span>{run.transcriptCount} messages</span><span>{run.usage.totalTokens.toLocaleString()} tokens</span><span>{run.usage.input.toLocaleString()} in / {run.usage.output.toLocaleString()} out</span>{run.budget && <span>{run.budget.tier} · {run.budget.maxContinuations} rounds · {run.budget.maxTokens.toLocaleString()} tokens</span>}</div>{run.blockedReason && <div className="blocked-note">{run.blockedReason}</div>}</section>
    {run.checkpoint && <section className="panel-section"><div className="section-title"><span>Checkpoint</span><small>{run.checkpoint.active ? "active" : "preserved"}</small></div><div className="checkpoint-card"><span>event {run.checkpoint.lastEventSeq} · transcript {run.checkpoint.lastTranscriptSeq}</span>{run.checkpoint.currentTool && <strong>{run.checkpoint.currentTool.toolName}</strong>}{run.checkpoint.assistantPartial && <p>{run.checkpoint.assistantPartial.slice(-240)}</p>}</div></section>}
    <section className="panel-section"><div className="section-title"><span>Supervisor</span><small>{run.supervision.latestDecision?.action ?? "observing"}</small></div><div className="checkpoint-card">{run.supervision.latestDecision ? <><strong>{run.supervision.latestDecision.reasonCode}</strong><p>{run.supervision.latestDecision.rationale}</p></> : <span>No intervention decision.</span>}{run.supervision.progress && <span>progress {run.supervision.progress.meaningfulChanges} · failures {run.supervision.progress.consecutiveFailures}</span>}{run.supervision.latestGates.map((gate) => <span key={gate.id}>{gate.gateType}: {gate.passed ? "passed" : `${gate.failures.length} failure(s)`}</span>)}</div></section>
    <section className="panel-section"><div className="section-title"><span>Plan</span><small>{run.plan.filter((item) => item.status === "done").length}/{run.plan.length}</small></div><div className="task-list">{run.plan.length ? run.plan.map((item) => <div className="task-row" key={item.key}>{item.status === "done" ? <Check size={15} /> : <Circle size={14} />}<span>{item.title}</span><small>{item.status}</small></div>) : <p className="muted">No structured plan.</p>}</div></section>
    <section className="panel-section"><div className="section-title"><span>Checks</span><small>{run.checks.filter((item) => item.status === "passed" && !item.stale).length}/{run.checks.length}</small></div><div className="task-list">{run.checks.length ? run.checks.map((check) => <div className="task-row" key={check.key}>{check.status === "passed" && !check.stale ? <Check size={15} /> : <Circle size={14} />}<span>{check.title}</span><small>{check.stale ? "stale" : check.status}</small></div>) : <p className="muted">No required checks.</p>}</div></section>
    <section className="panel-section"><div className="section-title"><span>Continuations</span><small>{run.continuations.length}</small></div><div className="task-list">{run.continuations.length ? run.continuations.map((item) => <div className="continuation-row" key={item.id}><div><strong>#{item.ordinal}</strong><span>{item.reason}</span></div><small className={`continuation-status ${item.status}`}>{item.status}{item.leaseUntil && item.status === "running" ? " · leased" : ""}</small></div>) : <p className="muted">No automatic continuation.</p>}</div></section>
    <section className="panel-section"><div className="section-title"><span>Artifacts</span><small>{run.artifacts.length}</small></div>{run.artifacts.map((artifact) => <div className="artifact-row" key={artifact.id}><FileText size={15} /><span>{artifact.title}</span></div>)}</section>
  </div>;
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeRun, setActiveRun] = useState<TaskRun | null>(null);
  const [selectedRun, setSelectedRun] = useState<TaskRun | null>(null);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [expandedRunId, setExpandedRunId] = useState("");
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [draft, setDraft] = useState("");
  const [inbox, setInbox] = useState<SessionInboxItem[]>([]);
  const [streaming, setStreaming] = useState("");
  const [error, setError] = useState("");
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const activeRunIdRef = useRef("");

  useEffect(() => { activeRunIdRef.current = activeRun?.id ?? ""; }, [activeRun?.id]);

  const loadSessions = useCallback(async () => {
    let items = await api.sessions();
    if (!items.length) items = [await api.createSession("First workspace")];
    setSessions(items);
    setSessionId((current) => current || items[0].id);
  }, []);

  useEffect(() => { void loadSessions(); void api.status().then(setRuntimeStatus); }, [loadSessions]);
  useEffect(() => {
    if (!sessionId) return;
    const timer = setInterval(() => {
      void Promise.all([api.inbox(sessionId), api.runs(sessionId), api.sessions()]).then(async ([queued, runHistory, sessionItems]) => {
        setInbox(queued);
        setRuns(runHistory);
        setSessions(sessionItems);
        const active = runHistory.find((item) => item.status === "running") ?? null;
        if (active?.id && active.id !== activeRunIdRef.current) {
          const [hydrated, history, view] = await Promise.all([api.run(active.id), api.messages(sessionId), api.transcriptView(active.id)]);
          setActiveRun(hydrated); setSelectedRun(hydrated); setExpandedRunId(hydrated.id);
          setMessages(history); setTranscript(view); setStreaming(hydrated.checkpoint?.active ? hydrated.checkpoint.assistantPartial : "");
          setEvents(hydrated.checkpoint?.active && hydrated.checkpoint.currentTool ? [{ runId: hydrated.id, seq: hydrated.checkpoint.lastEventSeq, type: "tool.started", data: hydrated.checkpoint.currentTool, createdAt: hydrated.checkpoint.updatedAt }] : []);
          setError("");
        } else if (!active && activeRunIdRef.current) {
          setActiveRun(null); setStreaming(""); setEvents([]);
          setMessages(await api.messages(sessionId));
        } else if (active) {
          setActiveRun((current) => current?.id === active.id ? { ...current, ...active } : active);
        }
      }).catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    setStreaming(""); setEvents([]); setError("");
    void Promise.all([api.messages(sessionId), api.runs(sessionId), api.inbox(sessionId)]).then(([history, runHistory, queued]) => {
      const latest = runHistory[0] ?? null;
      const active = runHistory.find((item) => item.status === "running") ?? null;
      setMessages(history); setRuns(runHistory); setInbox(queued); setActiveRun(active); setSelectedRun(latest); setExpandedRunId(latest?.id ?? "");
      setStreaming(active?.checkpoint?.active ? active.checkpoint.assistantPartial : "");
      setEvents(active?.checkpoint?.active && active.checkpoint.currentTool ? [{ runId: active.id, seq: active.checkpoint.lastEventSeq, type: "tool.started", data: active.checkpoint.currentTool, createdAt: active.checkpoint.updatedAt }] : []);
      if (latest) void api.transcriptView(latest.id).then(setTranscript); else setTranscript([]);
    });
  }, [sessionId]);

  useEffect(() => {
    if (!activeRun?.id || activeRun.status !== "running") return;
    let closed = false;
    let unsubscribe: () => void = () => {};
    const consumerKey = "tagent.eventConsumerId";
    let consumerId = localStorage.getItem(consumerKey);
    if (!consumerId) { consumerId = `web-${createRequestId()}`; localStorage.setItem(consumerKey, consumerId); }
    const runId = activeRun.id;
    const checkpointAfter = activeRun.checkpoint?.active ? activeRun.checkpoint.lastEventSeq : activeRun.lastEventSeq ?? 0;
    void api.claimConsumer(runId, consumerId).then((cursor) => {
      if (closed) return;
      setError("");
      const after = Math.max(checkpointAfter, cursor.ackedSeq);
      unsubscribe = subscribe(runId, consumerId, cursor.generation, after, async (event) => {
      setEvents((current) => [...current.slice(-39), event]);
      if (event.type === "message.delta") setStreaming((current) => current + String(event.data.delta ?? ""));
      if (["run.completed", "run.blocked", "run.failed", "run.cancelled"].includes(event.type)) {
        setStreaming("");
        const updated = await api.run(runId);
        const runHistory = await api.runs(sessionId);
        const nextActive = runHistory.find((item) => item.status === "running") ?? null;
        setActiveRun(nextActive);
        setSelectedRun((current) => current?.id === updated.id ? updated : current);
        setRuns(runHistory);
        setMessages(await api.messages(sessionId));
        setInbox(await api.inbox(sessionId));
        setTranscript(await api.transcriptView(updated.id));
        await loadSessions();
      } else if (event.type === "run.updated" || event.type.startsWith("tool.") || event.type.startsWith("continuation.") || event.type.startsWith("supervisor.")) {
        const updated = await api.run(runId);
        setActiveRun(updated);
        setSelectedRun((current) => current?.id === updated.id ? updated : current);
        setRuns((current) => current.map((item) => item.id === updated.id ? updated : item));
      }
      if (!closed) await api.ackConsumer(runId, consumerId, cursor.generation, event.seq).catch(() => undefined);
      }, () => undefined);
    }).catch((cause) => { if (!closed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { closed = true; unsubscribe(); };
  }, [activeRun?.id, activeRun?.status, sessionId, loadSessions]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, streaming, events]);

  const activeTools = useMemo(() => events.filter((event) => event.type.startsWith("tool.")).slice(-8), [events]);

  async function createSession() {
    const session = await api.createSession(`Workspace ${sessions.length + 1}`);
    setSessions((current) => [session, ...current]); setSessionId(session.id); setLeftOpen(false);
  }

  async function submit() {
    const content = draft.trim();
    if (!content || !sessionId) return;
    setDraft(""); setError("");
    try {
      const admission = await api.send(sessionId, content);
      setInbox(await api.inbox(sessionId));
      if (admission.run) {
        const nextRun = admission.run;
        setMessages(await api.messages(sessionId));
        setActiveRun(nextRun); setSelectedRun(nextRun); setRuns((current) => [nextRun, ...current.filter((item) => item.id !== nextRun.id)]); setExpandedRunId(nextRun.id); setEvents([]); setStreaming("");
      }
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return <div className="app-shell">
    <aside className={`session-rail ${leftOpen ? "mobile-open" : ""}`}>
      <div className="brand"><div className="brand-mark"><Bot size={18} /></div><div><strong>TAgent</strong><span>Core runtime</span></div><button className="icon-button mobile-only" onClick={() => setLeftOpen(false)} aria-label="Close sessions"><X size={18} /></button></div>
      <button className="new-session" onClick={createSession}><Plus size={16} />New workspace</button>
      <div className="session-list">
        {sessions.map((session) => <button key={session.id} className={`session-item ${session.id === sessionId ? "active" : ""}`} onClick={() => { setSessionId(session.id); setLeftOpen(false); }}>
          <span className="session-icon"><Command size={15} /></span><span><strong>{session.title}</strong><span className="session-meta"><small>{formatTime(session.updatedAt)}</small><WorkspaceRunStatus session={session} /></span></span>
        </button>)}
      </div>
      <div className="rail-footer"><span className="status-dot" />Local control plane{runtimeStatus?.schemaVersion ? ` · db v${runtimeStatus.schemaVersion}` : ""}</div>
    </aside>

    <main className="conversation">
      <header className="topbar">
        <button className="icon-button mobile-only" onClick={() => setLeftOpen(true)} aria-label="Open sessions"><Menu size={19} /></button>
        <div><h1>{sessions.find((session) => session.id === sessionId)?.title ?? "TAgent Core"}</h1><p>{activeRun ? `${activeRun.phase} · ${activeRun.status}` : runtimeStatus ? `${runtimeStatus.modelId} · ${runtimeStatus.runtime}` : "Ready for a new task"}</p></div>
        <div className="top-actions">{selectedRun && ["blocked", "interrupted"].includes(selectedRun.status) && !activeRun && <button className="resume-button" onClick={async () => { setError(""); try { const resumed = await api.resume(selectedRun.id); setActiveRun(resumed); setSelectedRun(resumed); setStreaming(""); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}><Play size={15} />Resume</button>}{activeRun?.status === "running" && <button className="icon-button danger" onClick={() => void api.cancel(activeRun.id)} title="Stop run" aria-label="Stop run"><Square size={17} /></button>}<button className="icon-button mobile-only" onClick={() => setRightOpen(true)} aria-label="Open task panel"><PanelRight size={19} /></button></div>
      </header>

      <section className="message-scroll">
        {!messages.length && !streaming && <div className="empty-state"><div className="empty-icon"><MessageSquarePlus size={25} /></div><h2>Start with an outcome</h2><p>TAgent will turn substantial work into a durable plan, execute tools, and hold completion behind checks.</p></div>}
        {messages.map((message) => <article key={message.id} className={`message ${message.role}`}><div className="message-meta"><span>{message.role === "user" ? "You" : "TAgent"}</span><time>{formatTime(message.createdAt)}</time></div><div className="message-body"><Markdown>{message.content}</Markdown></div></article>)}
        {selectedRun && transcript.some((item) => item.kind === "tool") && <section className="transcript-tools"><div className="transcript-heading"><span>Tool calls</span><small>{transcript.filter((item) => item.kind === "tool").length}</small></div>{transcript.filter((item): item is Extract<TranscriptItem, { kind: "tool" }> => item.kind === "tool").map((item) => <ToolCall key={`${item.seq}-${item.index}`} item={item} />)}</section>}
        {activeRun && <div className="active-run-strip"><Activity size={14} /><span>Attempt {activeRun.attempt}</span><strong>{activeRun.phase}</strong><small>{activeRun.usage.totalTokens.toLocaleString()} tokens</small></div>}
        {streaming && <article className="message assistant live"><div className="message-meta"><span>TAgent</span><span className="live-label"><span className="pulse" />Working</span></div><div className="message-body"><Markdown>{streaming}</Markdown></div></article>}
        {activeTools.length > 0 && <div className="tool-stack">{activeTools.map((event) => <div className="tool-row" key={`${event.seq}-${event.type}`}><Terminal size={14} /><span>{String(event.data.toolName ?? "tool")}</span><small>{event.type === "tool.started" ? "running" : event.data.isError ? "failed" : "done"}</small></div>)}</div>}
        <div ref={endRef} />
      </section>

      <footer className="composer-wrap">
        {error && <div className="error-banner">{error}</div>}
        <div className="composer-mode"><span><Activity size={13} />Supervisor inbox</span><span>{activeRun ? "New input waits below while the current TaskRun finishes" : "Supervisor starts the next eligible item"}</span></div>
        <div className="composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} placeholder="Add an outcome or instruction to the Supervisor queue" rows={1} /><button onClick={() => void submit()} disabled={!draft.trim()} aria-label="Add to Supervisor queue"><Send size={18} /></button></div>
        {inbox.length > 0 && <section className="supervisor-inbox"><div className="inbox-heading"><span>Up next</span><small>{inbox.length} queued</small></div>{inbox.map((item, index) => <div className="inbox-item" key={item.id}><span className="inbox-position">{index + 1}</span><div><strong>{item.content}</strong><small>{item.decision === "defer" ? "Deferred by Supervisor" : "Waiting for Supervisor selection"}</small><span className="inbox-actions"><button onClick={async () => { try { await api.decideInbox(sessionId, item.id, item.decision === "defer" ? "pending" : "defer"); setInbox(await api.inbox(sessionId)); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>{item.decision === "defer" ? "Resume" : "Defer"}</button>{index > 0 && <button onClick={async () => { try { await api.mergeInbox(sessionId, item.id, inbox[0].id); setInbox(await api.inbox(sessionId)); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>Merge first</button>}</span></div><button onClick={async () => { try { await api.deleteInbox(sessionId, item.id); setInbox(await api.inbox(sessionId)); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }} aria-label="Remove queued input"><X size={14} /></button></div>)}</section>}
      </footer>
    </main>

    <aside className={`run-panel ${rightOpen ? "mobile-open" : ""}`}>
      <div className="panel-heading"><div><span className="eyebrow">TaskRun</span><h2>Execution state</h2></div><button className="icon-button mobile-only" onClick={() => setRightOpen(false)} aria-label="Close task panel"><X size={18} /></button></div>
      {!runs.length ? <div className="panel-empty"><Play size={20} /><p>No TaskRuns</p></div> : <div className="run-history">{runs.map((item, index) => {
        const expanded = item.id === expandedRunId;
        return <section className={`run-history-item ${expanded ? "expanded" : ""}`} key={item.id}>
          <button className="run-history-toggle" onClick={async () => {
            if (expanded) { setExpandedRunId(""); return; }
            const selected = await api.run(item.id); setSelectedRun(selected); setExpandedRunId(item.id); setTranscript(await api.transcriptView(item.id));
          }} aria-expanded={expanded}>
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            <span className={`history-status ${item.status}`} />
            <span className="history-copy"><strong>{item.goal}</strong><small>{item.status} · attempt {item.attempt}{item.budget ? ` · ${item.budget.tier}` : ""}</small></span>
            <time>{index === 0 && item.status === "running" ? "current" : formatTime(item.updatedAt ?? item.createdAt)}</time>
          </button>
          {expanded && <RunDetails run={selectedRun?.id === item.id ? selectedRun : item} />}
        </section>;
      })}</div>}
    </aside>
    {(leftOpen || rightOpen) && <button className="backdrop mobile-only" onClick={() => { setLeftOpen(false); setRightOpen(false); }} aria-label="Close panel" />}
  </div>;
}
