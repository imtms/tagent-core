import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronDown, ChevronRight, Circle, Command, FileText, Menu, MessageSquarePlus, PanelRight, Play, Plus, Send, Square, Terminal, X } from "lucide-react";
import { api, subscribe, type Message, type RunEvent, type RuntimeStatus, type Session, type TaskRun } from "./api";

const formatTime = (value: number) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(value);

function RunDetails({ run }: { run: TaskRun }) {
  return <div className="run-details">
    <section className="run-summary"><div className="phase-line"><span className={`phase-badge ${run.status}`}>{run.status}</span><span>{run.phase}</span><span>attempt {run.attempt}</span></div><p>{run.goal}</p><div className="run-metrics"><span>{run.transcriptCount} messages</span><span>{run.usage.totalTokens.toLocaleString()} tokens</span><span>{run.usage.input.toLocaleString()} in / {run.usage.output.toLocaleString()} out</span>{run.budget && <span>{run.budget.tier} · {run.budget.maxContinuations} rounds · {run.budget.maxTokens.toLocaleString()} tokens</span>}</div>{run.blockedReason && <div className="blocked-note">{run.blockedReason}</div>}</section>
    <section className="panel-section"><div className="section-title"><span>Plan</span><small>{run.plan.filter((item) => item.status === "done").length}/{run.plan.length}</small></div><div className="task-list">{run.plan.length ? run.plan.map((item) => <div className="task-row" key={item.key}>{item.status === "done" ? <Check size={15} /> : <Circle size={14} />}<span>{item.title}</span><small>{item.status}</small></div>) : <p className="muted">No structured plan.</p>}</div></section>
    <section className="panel-section"><div className="section-title"><span>Checks</span><small>{run.checks.filter((item) => item.status === "passed" && !item.stale).length}/{run.checks.length}</small></div><div className="task-list">{run.checks.length ? run.checks.map((check) => <div className="task-row" key={check.key}>{check.status === "passed" && !check.stale ? <Check size={15} /> : <Circle size={14} />}<span>{check.title}</span><small>{check.stale ? "stale" : check.status}</small></div>) : <p className="muted">No required checks.</p>}</div></section>
    <section className="panel-section"><div className="section-title"><span>Continuations</span><small>{run.continuations.length}</small></div><div className="task-list">{run.continuations.length ? run.continuations.map((item) => <div className="continuation-row" key={item.id}><div><strong>#{item.ordinal}</strong><span>{item.reason}</span></div><small className={`continuation-status ${item.status}`}>{item.status}</small></div>) : <p className="muted">No automatic continuation.</p>}</div></section>
    <section className="panel-section"><div className="section-title"><span>Artifacts</span><small>{run.artifacts.length}</small></div>{run.artifacts.map((artifact) => <div className="artifact-row" key={artifact.id}><FileText size={15} /><span>{artifact.title}</span></div>)}</section>
  </div>;
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [run, setRun] = useState<TaskRun | null>(null);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [expandedRunId, setExpandedRunId] = useState("");
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState("");
  const [error, setError] = useState("");
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const loadSessions = useCallback(async () => {
    let items = await api.sessions();
    if (!items.length) items = [await api.createSession("First workspace")];
    setSessions(items);
    setSessionId((current) => current || items[0].id);
  }, []);

  useEffect(() => { void loadSessions(); void api.status().then(setRuntimeStatus); }, [loadSessions]);
  useEffect(() => {
    if (!sessionId) return;
    setStreaming(""); setEvents([]); setError("");
    void Promise.all([api.messages(sessionId), api.runs(sessionId)]).then(([history, runHistory]) => {
      const latest = runHistory[0] ?? null;
      setMessages(history); setRuns(runHistory); setRun(latest); setExpandedRunId(latest?.id ?? "");
    });
  }, [sessionId]);

  useEffect(() => {
    if (!run?.id || !["running", "interrupted"].includes(run.status)) return;
    return subscribe(run.id, run.lastEventSeq ?? 0, async (event) => {
      setEvents((current) => [...current.slice(-39), event]);
      if (event.type === "message.delta") setStreaming((current) => current + String(event.data.delta ?? ""));
      if (["run.completed", "run.blocked", "run.failed", "run.cancelled"].includes(event.type)) {
        setStreaming("");
        const updated = await api.run(run.id);
        setRun(updated);
        setRuns(await api.runs(sessionId));
        setMessages(await api.messages(sessionId));
        await loadSessions();
      } else if (event.type.startsWith("tool.") || event.type.startsWith("continuation.")) {
        const updated = await api.run(run.id);
        setRun(updated);
        setRuns((current) => current.map((item) => item.id === updated.id ? updated : item));
      }
    }, () => undefined);
  }, [run?.id, run?.status, run?.lastEventSeq, sessionId, loadSessions]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, streaming, events]);

  const activeTools = useMemo(() => events.filter((event) => event.type.startsWith("tool.")).slice(-8), [events]);

  async function createSession() {
    const session = await api.createSession(`Workspace ${sessions.length + 1}`);
    setSessions((current) => [session, ...current]); setSessionId(session.id); setLeftOpen(false);
  }

  async function submit() {
    const content = draft.trim();
    if (!content || !sessionId || run?.status === "running") return;
    setDraft(""); setError("");
    setMessages((current) => [...current, { id: Date.now(), sessionId, role: "user", content, createdAt: Date.now() }]);
    try {
      const nextRun = await api.send(sessionId, content);
      setRun(nextRun); setRuns((current) => [nextRun, ...current.filter((item) => item.id !== nextRun.id)]); setExpandedRunId(nextRun.id); setEvents([]); setStreaming("");
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return <div className="app-shell">
    <aside className={`session-rail ${leftOpen ? "mobile-open" : ""}`}>
      <div className="brand"><div className="brand-mark"><Bot size={18} /></div><div><strong>TAgent</strong><span>Core runtime</span></div><button className="icon-button mobile-only" onClick={() => setLeftOpen(false)} aria-label="Close sessions"><X size={18} /></button></div>
      <button className="new-session" onClick={createSession}><Plus size={16} />New workspace</button>
      <div className="session-list">
        {sessions.map((session) => <button key={session.id} className={`session-item ${session.id === sessionId ? "active" : ""}`} onClick={() => { setSessionId(session.id); setLeftOpen(false); }}>
          <span className="session-icon"><Command size={15} /></span><span><strong>{session.title}</strong><small>{formatTime(session.updatedAt)}</small></span>
        </button>)}
      </div>
      <div className="rail-footer"><span className="status-dot" />Local control plane{runtimeStatus?.schemaVersion ? ` · db v${runtimeStatus.schemaVersion}` : ""}</div>
    </aside>

    <main className="conversation">
      <header className="topbar">
        <button className="icon-button mobile-only" onClick={() => setLeftOpen(true)} aria-label="Open sessions"><Menu size={19} /></button>
        <div><h1>{sessions.find((session) => session.id === sessionId)?.title ?? "TAgent Core"}</h1><p>{run ? `${run.phase} · ${run.status}` : runtimeStatus ? `${runtimeStatus.modelId} · ${runtimeStatus.runtime}` : "Ready for a new task"}</p></div>
        <div className="top-actions">{run && ["blocked", "interrupted"].includes(run.status) && <button className="resume-button" onClick={async () => { setError(""); try { setRun(await api.resume(run.id)); setStreaming(""); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}><Play size={15} />Resume</button>}{run?.status === "running" && <button className="icon-button danger" onClick={() => void api.cancel(run.id)} title="Stop run"><Square size={17} /></button>}<button className="icon-button mobile-only" onClick={() => setRightOpen(true)} aria-label="Open task panel"><PanelRight size={19} /></button></div>
      </header>

      <section className="message-scroll">
        {!messages.length && !streaming && <div className="empty-state"><div className="empty-icon"><MessageSquarePlus size={25} /></div><h2>Start with an outcome</h2><p>TAgent will turn substantial work into a durable plan, execute tools, and hold completion behind checks.</p></div>}
        {messages.map((message) => <article key={message.id} className={`message ${message.role}`}><div className="message-meta"><span>{message.role === "user" ? "You" : "TAgent"}</span><time>{formatTime(message.createdAt)}</time></div><div className="message-body">{message.content}</div></article>)}
        {streaming && <article className="message assistant live"><div className="message-meta"><span>TAgent</span><span className="live-label"><span className="pulse" />Working</span></div><div className="message-body">{streaming}</div></article>}
        {activeTools.length > 0 && <div className="tool-stack">{activeTools.map((event) => <div className="tool-row" key={`${event.seq}-${event.type}`}><Terminal size={14} /><span>{String(event.data.toolName ?? "tool")}</span><small>{event.type === "tool.started" ? "running" : event.data.isError ? "failed" : "done"}</small></div>)}</div>}
        <div ref={endRef} />
      </section>

      <footer className="composer-wrap">
        {error && <div className="error-banner">{error}</div>}
        <div className="composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} placeholder={run?.status === "running" ? "Run in progress" : "Describe the outcome you need"} disabled={run?.status === "running"} rows={1} /><button onClick={() => void submit()} disabled={!draft.trim() || run?.status === "running"} aria-label="Send"><Send size={18} /></button></div>
      </footer>
    </main>

    <aside className={`run-panel ${rightOpen ? "mobile-open" : ""}`}>
      <div className="panel-heading"><div><span className="eyebrow">TaskRun</span><h2>Execution state</h2></div><button className="icon-button mobile-only" onClick={() => setRightOpen(false)} aria-label="Close task panel"><X size={18} /></button></div>
      {!runs.length ? <div className="panel-empty"><Play size={20} /><p>No TaskRuns</p></div> : <div className="run-history">{runs.map((item, index) => {
        const expanded = item.id === expandedRunId;
        return <section className={`run-history-item ${expanded ? "expanded" : ""}`} key={item.id}>
          <button className="run-history-toggle" onClick={async () => {
            if (expanded) { setExpandedRunId(""); return; }
            const selected = await api.run(item.id); setRun(selected); setExpandedRunId(item.id); setEvents([]); setStreaming("");
          }} aria-expanded={expanded}>
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            <span className={`history-status ${item.status}`} />
            <span className="history-copy"><strong>{item.goal}</strong><small>{item.status} · attempt {item.attempt}{item.budget ? ` · ${item.budget.tier}` : ""}</small></span>
            <time>{index === 0 && item.status === "running" ? "current" : formatTime(item.updatedAt ?? item.createdAt)}</time>
          </button>
          {expanded && <RunDetails run={run?.id === item.id ? run : item} />}
        </section>;
      })}</div>}
    </aside>
    {(leftOpen || rightOpen) && <button className="backdrop mobile-only" onClick={() => { setLeftOpen(false); setRightOpen(false); }} aria-label="Close panel" />}
  </div>;
}
