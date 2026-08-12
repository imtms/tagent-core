import { useEffect, useRef, type RefObject } from "react";

type GestureMode = "open" | "close";

export function drawerGestureDecision(mode: GestureMode, deltaX: number, deltaY: number, slop = 10): "pending" | "engage" | "reject" {
  if (Math.abs(deltaX) < slop && Math.abs(deltaY) < slop) return "pending";
  const movesInExpectedDirection = mode === "open" ? deltaX > 0 : deltaX < 0;
  return movesInExpectedDirection && Math.abs(deltaX) > Math.abs(deltaY) * 1.15 ? "engage" : "reject";
}

export function shouldSettleDrawerOpen(visibleFraction: number, velocityX: number): boolean {
  return Math.abs(velocityX) > 0.3 ? velocityX > 0 : visibleFraction > 0.5;
}

export function useMobileDrawerSwipe({
  open,
  enabled,
  drawerRef,
  backdropRef,
  onOpenChange,
}: {
  open: boolean;
  enabled: boolean;
  drawerRef: RefObject<HTMLElement | null>;
  backdropRef: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
}) {
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const drawer = drawerRef.current;
    const backdrop = backdropRef.current;
    if (!drawer || !backdrop || !enabled) return;

    const edgeWidth = 28;
    let mode: GestureMode | null = null;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastTime = 0;
    let velocityX = 0;
    let currentOffset = 0;
    let engaged = false;
    let restoreTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

    const isMobile = () => globalThis.matchMedia?.("(max-width: 980px)").matches === true;
    const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const drawerWidth = () => drawer.getBoundingClientRect().width || 304;
    const hasAnotherModal = () => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')).some((dialog) => dialog !== drawer);

    const paint = (offset: number) => {
      const width = drawerWidth();
      currentOffset = Math.max(-width, Math.min(0, offset));
      const visibleFraction = Math.max(0, Math.min(1, (currentOffset + width) / width));
      drawer.style.visibility = "visible";
      drawer.style.transition = "none";
      drawer.style.transform = `translateX(${currentOffset}px)`;
      backdrop.style.visibility = "visible";
      backdrop.style.transition = "none";
      backdrop.style.opacity = String(visibleFraction);
      backdrop.style.pointerEvents = visibleFraction > 0.01 ? "auto" : "none";
    };

    const restoreStyles = () => {
      drawer.style.removeProperty("visibility");
      drawer.style.removeProperty("transition");
      drawer.style.removeProperty("transform");
      backdrop.style.removeProperty("visibility");
      backdrop.style.removeProperty("transition");
      backdrop.style.removeProperty("opacity");
      backdrop.style.removeProperty("pointer-events");
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (restoreTimer) { globalThis.clearTimeout(restoreTimer); restoreTimer = undefined; restoreStyles(); }
      if (!isMobile() || event.touches.length !== 1 || hasAnotherModal()) { mode = null; return; }
      const touch = event.touches[0];
      if (openRef.current) {
        if (!drawer.contains(event.target as Node)) { mode = null; return; }
        mode = "close";
      } else if (touch.clientX <= edgeWidth) {
        mode = "open";
      } else {
        mode = null;
        return;
      }
      startX = lastX = touch.clientX;
      startY = touch.clientY;
      lastTime = event.timeStamp;
      velocityX = 0;
      engaged = false;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!mode || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      if (!engaged) {
        const decision = drawerGestureDecision(mode, deltaX, deltaY);
        if (decision === "pending") return;
        if (decision === "reject") { mode = null; return; }
        engaged = true;
      }
      event.preventDefault();
      if (event.timeStamp > lastTime) velocityX = (touch.clientX - lastX) / (event.timeStamp - lastTime);
      lastX = touch.clientX;
      lastTime = event.timeStamp;
      const width = drawerWidth();
      paint((mode === "open" ? -width : 0) + deltaX);
    };

    const handleTouchEnd = () => {
      if (!mode || !engaged) { mode = null; engaged = false; return; }
      const width = drawerWidth();
      const visibleFraction = (currentOffset + width) / width;
      const settleOpen = shouldSettleDrawerOpen(visibleFraction, velocityX);
      const duration = reducedMotion() ? 0 : 180;
      drawer.style.transition = `transform ${duration}ms var(--ease-out)`;
      drawer.style.transform = settleOpen ? "translateX(0)" : `translateX(-${width}px)`;
      backdrop.style.transition = `opacity ${duration}ms var(--ease-out)`;
      backdrop.style.opacity = settleOpen ? "1" : "0";
      backdrop.style.pointerEvents = settleOpen ? "auto" : "none";
      onOpenChange(settleOpen);
      restoreTimer = globalThis.setTimeout(restoreStyles, duration + 24);
      mode = null;
      engaged = false;
    };

    document.addEventListener("touchstart", handleTouchStart, { passive: true });
    document.addEventListener("touchmove", handleTouchMove, { passive: false });
    document.addEventListener("touchend", handleTouchEnd, { passive: true });
    document.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    return () => {
      if (restoreTimer) globalThis.clearTimeout(restoreTimer);
      restoreStyles();
      document.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", handleTouchEnd);
      document.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [backdropRef, drawerRef, enabled, onOpenChange]);
}
