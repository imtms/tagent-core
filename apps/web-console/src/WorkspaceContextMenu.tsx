import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from "react";
import { Pencil, Pin } from "lucide-react";
import { createPortal } from "react-dom";
import type { Session } from "./api";
import { ICON_SIZE } from "./icon-size";

export function WorkspaceContextMenu({
  workspace,
  pinned,
  currentEmoji,
  emojis,
  position,
  onClose,
  onTogglePinned,
  onRename,
  onChooseEmoji,
}: {
  workspace: Session;
  pinned: boolean;
  currentEmoji: string;
  emojis: readonly string[];
  position: CSSProperties;
  onClose: () => void;
  onTogglePinned: () => void;
  onRename: () => void;
  onChooseEmoji: (emoji: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(true);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (restoreFocusRef.current) previouslyFocusedRef.current?.focus({ preventScroll: true });
    };
  }, []);

  function focusItems(): HTMLButtonElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = focusItems();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (!items.length) return;
    if (event.key === "ArrowDown") { event.preventDefault(); items[(current + 1 + items.length) % items.length]?.focus(); }
    if (event.key === "ArrowUp") { event.preventDefault(); items[(current - 1 + items.length) % items.length]?.focus(); }
    if (event.key === "Home") { event.preventDefault(); items[0]?.focus(); }
    if (event.key === "End") { event.preventDefault(); items.at(-1)?.focus(); }
  }

  return createPortal(<>
    <div className="workspace-context-menu-scrim" aria-hidden="true" onMouseDown={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }} />
    <div ref={menuRef} className="workspace-context-menu" role="menu" aria-label={`Actions for ${workspace.title}`} style={position} onKeyDown={handleKeyDown}>
      <button type="button" role="menuitem" onClick={() => { onTogglePinned(); onClose(); }}><Pin size={ICON_SIZE.sm} /><span>{pinned ? "Unpin workspace" : "Pin workspace"}</span></button>
      <button type="button" role="menuitem" onClick={() => { restoreFocusRef.current = false; onRename(); onClose(); }}><Pencil size={ICON_SIZE.sm} /><span>Rename workspace</span></button>
      <div className="workspace-avatar-options" role="group" aria-label="Workspace icon"><span data-label>Icon</span><div>{emojis.map((emoji) => <button type="button" role="menuitemradio" aria-label={`Use ${emoji} for ${workspace.title}`} aria-checked={currentEmoji === emoji} key={emoji} onClick={() => { onChooseEmoji(emoji); onClose(); }}>{emoji}</button>)}</div></div>
    </div>
  </>, document.body);
}
