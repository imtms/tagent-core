import { useEffect, useRef, type RefObject } from "react";
import { focusableElements } from "./focusable-elements";

export function usePopoverFocus(open: boolean, popoverRef: RefObject<HTMLElement | null>, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const popover = popoverRef.current;
    const focusableItems = () => focusableElements(popover);
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
    popover?.addEventListener("keydown", handleKeyDown);
    const frame = requestAnimationFrame(() => focusableItems()[0]?.focus());
    return () => {
      cancelAnimationFrame(frame);
      popover?.removeEventListener("keydown", handleKeyDown);
      previous?.focus({ preventScroll: true });
    };
  }, [open, popoverRef]);
}
