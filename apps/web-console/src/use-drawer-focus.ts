import { useEffect, useState, type RefObject } from "react";
import { focusableElements } from "./focusable-elements";

const mobileDrawerQuery = "(max-width: 980px)";

export function useMobileDrawerLayout(): boolean {
  const [mobile, setMobile] = useState(() => globalThis.matchMedia?.(mobileDrawerQuery).matches === true);
  useEffect(() => {
    const media = globalThis.matchMedia?.(mobileDrawerQuery);
    if (!media) return;
    const sync = () => setMobile(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return mobile;
}

export function useDrawerFocus(open: boolean, drawerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const drawer = drawerRef.current;
    const siblings = Array.from(drawer?.parentElement?.children ?? []).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== drawer && !element.classList.contains("backdrop"));
    const siblingState = siblings.map((element) => ({ element, inert: element.inert, ariaHidden: element.getAttribute("aria-hidden") }));
    for (const element of siblings) { element.inert = true; element.setAttribute("aria-hidden", "true"); }
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = focusableElements(drawer);
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
