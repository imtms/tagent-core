import { useEffect, useRef, type RefObject } from "react";
import { focusableElements } from "./focusable-elements";

export function useModalFocus(
  open: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>,
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appShell = document.querySelector<HTMLElement>(".app-shell");
    const wasInert = appShell?.inert ?? false;
    const previousAriaHidden = appShell?.getAttribute("aria-hidden") ?? null;
    if (appShell) { appShell.inert = true; appShell.setAttribute("aria-hidden", "true"); }

    const focusableItems = () => focusableElements(dialog);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCloseRef.current(); return; }
      if (event.key !== "Tab") return;
      const focusable = focusableItems();
      if (!focusable.length) return;
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current + 1) % focusable.length;
      focusable[next]?.focus();
    };
    dialog?.addEventListener("keydown", handleKeyDown);
    const frame = requestAnimationFrame(() => (initialFocusRef?.current ?? focusableItems()[0])?.focus());
    return () => {
      cancelAnimationFrame(frame);
      dialog?.removeEventListener("keydown", handleKeyDown);
      if (appShell) {
        appShell.inert = wasInert;
        if (previousAriaHidden === null) appShell.removeAttribute("aria-hidden");
        else appShell.setAttribute("aria-hidden", previousAriaHidden);
      }
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [dialogRef, initialFocusRef, open]);
}
