import { useRef } from "react";
import { createPortal } from "react-dom";
import { Keyboard, X } from "lucide-react";
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

  return createPortal(<div className="shortcut-help-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="shortcut-help" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title">
      <header><span><Keyboard size={17} /></span><div><small>Keyboard first</small><h2 id="shortcut-help-title">Keyboard shortcuts</h2></div><button ref={closeRef} type="button" onClick={onClose} aria-label="Close keyboard shortcuts"><X size={16} /></button></header>
      <div className="shortcut-help-groups">{groups.map((group) => <section key={group.label}><h3>{group.label}</h3><div>{group.shortcuts.map((shortcut) => <div className="shortcut-help-row" key={shortcut.label}><span>{shortcut.label}</span><kbd>{shortcut.keys.map((key) => <i key={key}>{key}</i>)}</kbd></div>)}</div></section>)}</div>
      <footer>Shortcuts are available wherever they do not interrupt typing.</footer>
    </section>
  </div>, document.body);
}
