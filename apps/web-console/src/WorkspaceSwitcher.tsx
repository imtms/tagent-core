import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, ArrowRight, CornerDownLeft, Pin, Plus, Search, X } from "lucide-react";
import type { Session } from "./api";
import { ICON_SIZE } from "./icon-size";
import { formatRunStatus, runStatusTone } from "./run-state";
import { TimeAgo } from "./TimeAgo";
import { useModalFocus } from "./use-modal-focus";
import { workspaceEmptyState } from "./workspace-navigation";

export function WorkspaceSwitcher({
  open,
  workspaces,
  selectedWorkspaceId,
  pinnedWorkspaceIds,
  workspaceEmojiById,
  creating,
  onClose,
  onSelect,
  onCreate,
  onPrefetch,
}: {
  open: boolean;
  workspaces: Session[];
  selectedWorkspaceId: string;
  pinnedWorkspaceIds: string[];
  workspaceEmojiById: Record<string, string>;
  creating: boolean;
  onClose: () => void;
  onSelect: (workspace: Session) => void;
  onCreate: () => void | Promise<void>;
  onPrefetch: (workspaceId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const initializedOpenRef = useRef(false);
  const sortedWorkspaces = useMemo(() => [...workspaces]
    .sort((left, right) => Number(pinnedWorkspaceIds.includes(right.id)) - Number(pinnedWorkspaceIds.includes(left.id)) || right.updatedAt - left.updatedAt), [pinnedWorkspaceIds, workspaces]);
  const visibleWorkspaces = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return sortedWorkspaces.filter((workspace) => !normalized || workspace.title.toLocaleLowerCase().includes(normalized));
  }, [query, sortedWorkspaces]);
  const emptyState = workspaceEmptyState(workspaces.length, visibleWorkspaces.length);
  useModalFocus(open, dialogRef, onClose, sortedWorkspaces.length > 0 ? inputRef : createButtonRef);

  useEffect(() => {
    if (!open) { initializedOpenRef.current = false; return; }
    if (initializedOpenRef.current) return;
    initializedOpenRef.current = true;
    setQuery("");
    setActiveIndex(Math.max(0, sortedWorkspaces.findIndex((workspace) => workspace.id === selectedWorkspaceId)));
  }, [open, selectedWorkspaceId, sortedWorkspaces]);

  useEffect(() => { setActiveIndex((current) => Math.min(current, Math.max(visibleWorkspaces.length - 1, 0))); }, [visibleWorkspaces.length]);
  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
    const activeWorkspace = visibleWorkspaces[activeIndex];
    if (activeWorkspace) onPrefetch(activeWorkspace.id);
  }, [activeIndex, onPrefetch, open, visibleWorkspaces]);
  if (!open) return null;

  function choose(workspace: Session) {
    onSelect(workspace);
    onClose();
  }

  function moveActive(delta: number) {
    if (!visibleWorkspaces.length) return;
    setActiveIndex((current) => (current + delta + visibleWorkspaces.length) % visibleWorkspaces.length);
  }

  return createPortal(<div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="modal workspace-switcher" role="dialog" aria-modal="true" aria-labelledby="workspace-switcher-title">
      <header>
        <div className="modal-title-group"><h2 className="truncate" id="workspace-switcher-title">Switch workspace</h2></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close workspace switcher"><X size={ICON_SIZE.md} /></button>
      </header>
      {sortedWorkspaces.length > 0 && <label className="workspace-switcher-search">
        <Search size={ICON_SIZE.md} />
        <input ref={inputRef} role="combobox" aria-controls="workspace-switcher-results" aria-expanded="true" aria-activedescendant={visibleWorkspaces[activeIndex] ? `workspace-option-${visibleWorkspaces[activeIndex].id}` : undefined} value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); moveActive(1); }
          if (event.key === "ArrowUp") { event.preventDefault(); moveActive(-1); }
          if (event.key === "Home" && visibleWorkspaces.length) { event.preventDefault(); setActiveIndex(0); }
          if (event.key === "End" && visibleWorkspaces.length) { event.preventDefault(); setActiveIndex(visibleWorkspaces.length - 1); }
          if (event.key === "Enter" && visibleWorkspaces[activeIndex]) { event.preventDefault(); choose(visibleWorkspaces[activeIndex]); }
        }} placeholder="Search by workspace name…" aria-label="Search all workspaces" />
        <kbd>esc</kbd>
      </label>}
      <div className="workspace-switcher-results" id="workspace-switcher-results" role="listbox" aria-label="Workspaces">
        {visibleWorkspaces.map((workspace, index) => {
          const pinned = pinnedWorkspaceIds.includes(workspace.id);
          const selected = workspace.id === selectedWorkspaceId;
          const customWorkspaceEmoji = workspaceEmojiById[workspace.id];
          return <button ref={(element) => { optionRefs.current[index] = element; }} id={`workspace-option-${workspace.id}`} type="button" role="option" tabIndex={-1} aria-selected={selected} className={index === activeIndex ? "highlighted" : undefined} key={workspace.id} onMouseEnter={() => { setActiveIndex(index); onPrefetch(workspace.id); }} onClick={() => choose(workspace)}>
            <span className={customWorkspaceEmoji ? "workspace-switcher-avatar custom" : "workspace-switcher-avatar"}>{(customWorkspaceEmoji ?? workspace.title.trim().slice(0, 1).toLocaleUpperCase()) || "T"}</span>
            <span className="workspace-switcher-copy"><strong className="truncate">{workspace.title}</strong><small className="meta-line truncate"><TimeAgo value={workspace.updatedAt} />{workspace.latestRunStatus && <i data-meta data-tone={runStatusTone(workspace.latestRunStatus)}>{workspace.latestRunStatus === "running" ? <Activity size={ICON_SIZE.micro} /> : <span className="status-dot" />}{formatRunStatus(workspace.latestRunStatus)}</i>}</small></span>
            {pinned && <Pin data-meta size={ICON_SIZE.sm} />}
            {selected ? <span data-meta>Current</span> : index === activeIndex ? <CornerDownLeft size={ICON_SIZE.sm} /> : <ArrowRight size={ICON_SIZE.sm} />}
          </button>;
        })}
        {emptyState && <div className="workspace-switcher-empty">{emptyState.kind === "no-workspaces" ? <Plus size={ICON_SIZE.xl} /> : <Search size={ICON_SIZE.xl} />}<strong>{emptyState.title}</strong><span>{emptyState.detail}</span></div>}
      </div>
      <footer><button ref={createButtonRef} className="control" data-variant="primary" type="button" disabled={creating} aria-busy={creating} onClick={() => { onClose(); void onCreate(); }}>{creating ? <Activity className="spin" size={ICON_SIZE.md} /> : <Plus size={ICON_SIZE.md} />}<span>{creating ? "Creating…" : "New workspace"}</span></button>{sortedWorkspaces.length > 0 && <span><kbd>↑</kbd><kbd>↓</kbd> navigate <kbd>↵</kbd> open</span>}</footer>
    </section>
  </div>, document.body);
}
