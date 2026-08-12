import { useEffect, type RefObject } from "react";

export function useDrawerFocus(open: boolean, drawerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open || !globalThis.matchMedia?.("(max-width: 980px)").matches) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const drawer = drawerRef.current;
    const siblings = Array.from(drawer?.parentElement?.children ?? []).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== drawer && !element.classList.contains("backdrop"));
    const siblingState = siblings.map((element) => ({ element, inert: element.inert, ariaHidden: element.getAttribute("aria-hidden") }));
    for (const element of siblings) { element.inert = true; element.setAttribute("aria-hidden", "true"); }
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(drawer?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? []).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current + 1) % focusable.length;
      focusable[next]?.focus();
    };
    drawer?.addEventListener("keydown", trapFocus);
    const frame = requestAnimationFrame(() => drawer?.querySelector<HTMLElement>("[data-drawer-close]")?.focus());
    return () => {
      cancelAnimationFrame(frame);
      drawer?.removeEventListener("keydown", trapFocus);
      for (const { element, inert, ariaHidden } of siblingState) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden"); else element.setAttribute("aria-hidden", ariaHidden);
      }
      previous?.focus({ preventScroll: true });
    };
  }, [drawerRef, open]);
}
