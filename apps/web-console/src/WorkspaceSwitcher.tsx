import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, ArrowRight, Circle, CornerDownLeft, Pin, Plus, Search, X } from "lucide-react";
import type { Session } from "./api";
import { useModalFocus } from "./useModalFocus";

function statusLabel(session: Session): string {
  if (!session.latestRunStatus) return "No tasks";
  return session.latestRunStatus === "waiting_input" ? "Needs input" : session.latestRunStatus.replaceAll("_", " ");
}

export function WorkspaceSwitcher({
  open,
  sessions,
  selectedSessionId,
  pinnedSessionIds,
  workspaceEmojiById,
  onClose,
  onSelect,
  onCreate,
  onPrefetch,
}: {
  open: boolean;
  sessions: Session[];
  selectedSessionId: string;
  pinnedSessionIds: string[];
  workspaceEmojiById: Record<string, string>;
  onClose: () => void;
  onSelect: (session: Session) => void;
  onCreate: () => void | Promise<void>;
  onPrefetch: (sessionId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const initializedOpenRef = useRef(false);
  const sortedSessions = useMemo(() => [...sessions]
    .sort((left, right) => Number(pinnedSessionIds.includes(right.id)) - Number(pinnedSessionIds.includes(left.id)) || right.updatedAt - left.updatedAt), [pinnedSessionIds, sessions]);
  const ordered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return sortedSessions.filter((session) => !normalized || session.title.toLocaleLowerCase().includes(normalized));
  }, [query, sortedSessions]);
  useModalFocus(open, dialogRef, onClose, inputRef);

  useEffect(() => {
    if (!open) { initializedOpenRef.current = false; return; }
    if (initializedOpenRef.current) return;
    initializedOpenRef.current = true;
    setQuery("");
    setActiveIndex(Math.max(0, sortedSessions.findIndex((session) => session.id === selectedSessionId)));
  }, [open, selectedSessionId, sortedSessions]);

  useEffect(() => { setActiveIndex((current) => Math.min(current, Math.max(ordered.length - 1, 0))); }, [ordered.length]);
  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
    const activeSession = ordered[activeIndex];
    if (activeSession) onPrefetch(activeSession.id);
  }, [activeIndex, onPrefetch, open, ordered]);
  if (!open) return null;

  function choose(session: Session) {
    onSelect(session);
    onClose();
  }

  function moveActive(delta: number) {
    if (!ordered.length) return;
    setActiveIndex((current) => (current + delta + ordered.length) % ordered.length);
  }

  return createPortal(<div className="workspace-switcher-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="workspace-switcher" role="dialog" aria-modal="true" aria-labelledby="workspace-switcher-title">
      <header>
        <div><span>Navigate</span><h2 id="workspace-switcher-title">Switch workspace</h2></div>
        <button type="button" onClick={onClose} aria-label="Close workspace switcher"><X size={16} /></button>
      </header>
      <label className="workspace-switcher-search">
        <Search size={16} />
        <input ref={inputRef} role="combobox" aria-controls="workspace-switcher-results" aria-expanded="true" aria-activedescendant={ordered[activeIndex] ? `workspace-option-${ordered[activeIndex].id}` : undefined} value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); moveActive(1); }
          if (event.key === "ArrowUp") { event.preventDefault(); moveActive(-1); }
          if (event.key === "Home" && ordered.length) { event.preventDefault(); setActiveIndex(0); }
          if (event.key === "End" && ordered.length) { event.preventDefault(); setActiveIndex(ordered.length - 1); }
          if (event.key === "Enter" && ordered[activeIndex]) { event.preventDefault(); choose(ordered[activeIndex]); }
        }} placeholder="Search by workspace name…" aria-label="Search all workspaces" />
        <kbd>esc</kbd>
      </label>
      <div className="workspace-switcher-results" id="workspace-switcher-results" role="listbox" aria-label="Workspaces">
        {ordered.map((session, index) => {
          const pinned = pinnedSessionIds.includes(session.id);
          const selected = session.id === selectedSessionId;
          return <button ref={(element) => { optionRefs.current[index] = element; }} id={`workspace-option-${session.id}`} type="button" role="option" tabIndex={-1} aria-selected={selected} className={`${index === activeIndex ? "highlighted" : ""} ${selected ? "selected" : ""}`} key={session.id} onMouseEnter={() => { setActiveIndex(index); onPrefetch(session.id); }} onClick={() => choose(session)}>
            <span className="workspace-switcher-avatar">{workspaceEmojiById[session.id] ?? "💬"}</span>
            <span className="workspace-switcher-copy"><strong>{session.title}</strong><small><time>{new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(session.updatedAt)}</time><i className={`workspace-switcher-status ${session.latestRunStatus ?? "idle"}`}>{session.latestRunStatus === "running" ? <Activity size={10} /> : <Circle size={7} />}{statusLabel(session)}</i></small></span>
            {pinned && <Pin className="workspace-switcher-pin" size={13} />}
            {selected ? <span className="workspace-switcher-current">Current</span> : index === activeIndex ? <CornerDownLeft className="workspace-switcher-enter" size={14} /> : <ArrowRight className="workspace-switcher-arrow" size={14} />}
          </button>;
        })}
        {!ordered.length && <div className="workspace-switcher-empty"><Search size={20} /><strong>No matching workspaces</strong><span>Try another name or create a new workspace.</span></div>}
      </div>
      <footer><button type="button" onClick={() => { onClose(); void onCreate(); }}><Plus size={15} /><span>New workspace</span></button><span><kbd>↑</kbd><kbd>↓</kbd> navigate <kbd>↵</kbd> open</span></footer>
    </section>
  </div>, document.body);
}
