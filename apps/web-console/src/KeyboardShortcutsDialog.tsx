import { useRef } from "react";
import { createPortal } from "react-dom";
import { Keyboard, X } from "lucide-react";
import { ICON_SIZE } from "./icon-size";
import { shortcutKeyTokens, type ShortcutModifier } from "./shortcut-platform";
import { useModalFocus } from "./use-modal-focus";

export function KeyboardShortcutsDialog({ open, modifier, enterSubmits, onClose }: { open: boolean; modifier: ShortcutModifier; enterSubmits: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useModalFocus(open, dialogRef, onClose, closeRef);
  if (!open) return null;

  const groups = [
    { label: "Navigation", shortcuts: [{ label: "Switch workspace", keys: shortcutKeyTokens(modifier, "K") }] },
    { label: "Conversation", shortcuts: [
      { label: "Focus message composer", keys: ["/"] },
      ...(enterSubmits ? [
        { label: "Send message", keys: ["Enter"] },
        { label: "Add a new line", keys: ["Shift", "Enter"] },
      ] : []),
    ] },
    { label: "General", shortcuts: [
      { label: "Show keyboard shortcuts", keys: ["?"] },
      { label: "Close dialog or panel", keys: ["Esc"] },
    ] },
  ];

  return createPortal(<div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="modal shortcut-help" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title">
      <header><div className="modal-heading"><Keyboard size={ICON_SIZE.lg} /><div className="modal-title-group"><h2 className="truncate" id="shortcut-help-title">Keyboard shortcuts</h2></div></div><button ref={closeRef} className="icon-button" type="button" onClick={onClose} aria-label="Close keyboard shortcuts"><X size={ICON_SIZE.md} /></button></header>
      <div className="shortcut-help-groups">{groups.map((group) => <section key={group.label}><h3>{group.label}</h3><div>{group.shortcuts.map((shortcut) => <div className="shortcut-help-row" key={shortcut.label}><span>{shortcut.label}</span><kbd>{shortcut.keys.map((key) => <i key={key}>{key}</i>)}</kbd></div>)}</div></section>)}</div>
      <footer>Shortcuts are available wherever they do not interrupt typing.</footer>
    </section>
  </div>, document.body);
}
