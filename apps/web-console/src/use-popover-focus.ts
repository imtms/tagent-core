import { useEffect, type RefObject } from "react";

export function usePopoverFocus(open: boolean, popoverRef: RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const popover = popoverRef.current;
    const focusableItems = () => Array.from(popover?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? []).filter((element) => element.getClientRects().length > 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key !== "Tab") return;
      const focusable = focusableItems();
      if (!focusable.length) return;
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current + 1) % focusable.length;
      focusable[next]?.focus();
    };
    popover?.addEventListener("keydown", handleKeyDown);
    const frame = requestAnimationFrame(() => focusableItems()[0]?.focus());
    return () => {
      cancelAnimationFrame(frame);
      popover?.removeEventListener("keydown", handleKeyDown);
      previous?.focus({ preventScroll: true });
    };
  }, [onClose, open, popoverRef]);
}
