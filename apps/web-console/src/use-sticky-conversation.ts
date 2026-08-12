import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { nextConversationPinState } from "./conversation-scroll";

const settleAfterResizeMs = 360;
const settleFrames = 2;

export function useStickyConversation(resetKey: string, activityKey: string, stageRef: RefObject<HTMLElement | null>) {
  const viewportRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const programmaticRef = useRef(false);
  const previousTopRef = useRef(0);
  const previousHeightRef = useRef(0);
  const settleUntilRef = useRef(0);
  const previousActivityRef = useRef(activityKey);
  const latestActivityRef = useRef(activityKey);
  latestActivityRef.current = activityKey;
  const activityReadyRef = useRef(false);
  const [pinnedToLatest, setPinnedToLatest] = useState(true);
  const [hasNewActivity, setHasNewActivity] = useState(false);

  const setPinned = useCallback((value: boolean) => {
    pinnedRef.current = value;
    setPinnedToLatest(value);
    if (value) setHasNewActivity(false);
  }, []);

  const writeLatest = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    programmaticRef.current = true;
    viewport.scrollTop = viewport.scrollHeight;
    requestAnimationFrame(() => { programmaticRef.current = false; });
  }, []);

  const jumpToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setPinned(true);
    settleUntilRef.current = Date.now() + settleAfterResizeMs;
    programmaticRef.current = true;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    requestAnimationFrame(() => { programmaticRef.current = false; });
  }, [setPinned]);

  const pinToLatest = useCallback(() => {
    setPinned(true);
    settleUntilRef.current = Date.now() + settleAfterResizeMs;
    writeLatest();
  }, [setPinned, writeLatest]);

  useEffect(() => {
    activityReadyRef.current = false;
    previousActivityRef.current = latestActivityRef.current;
    setPinned(true);
    settleUntilRef.current = Date.now() + settleAfterResizeMs;
    const frame = requestAnimationFrame(writeLatest);
    const ready = requestAnimationFrame(() => { activityReadyRef.current = true; });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(ready); };
  }, [resetKey, setPinned, writeLatest]);

  useEffect(() => {
    if (previousActivityRef.current === activityKey) return;
    previousActivityRef.current = activityKey;
    if (activityReadyRef.current && !pinnedRef.current) setHasNewActivity(true);
  }, [activityKey]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const stage = stageRef.current;
    if (!viewport || !content || typeof ResizeObserver === "undefined") return;
    previousTopRef.current = viewport.scrollTop;
    previousHeightRef.current = viewport.clientHeight;
    let framesLeft = 0;
    let frame = 0;
    const settle = () => {
      frame = 0;
      if (framesLeft <= 0 || Date.now() > settleUntilRef.current) return;
      framesLeft -= 1;
      if (pinnedRef.current) writeLatest();
      frame = requestAnimationFrame(settle);
    };
    const kick = () => {
      framesLeft = Math.max(framesLeft, settleFrames);
      if (!frame) frame = requestAnimationFrame(settle);
    };
    const observer = new ResizeObserver((entries) => {
      const contentChanged = entries.some((entry) => entry.target === content);
      settleUntilRef.current = Date.now() + settleAfterResizeMs;
      if (pinnedRef.current) writeLatest();
      else if (contentChanged && activityReadyRef.current) setHasNewActivity(true);
      kick();
    });
    observer.observe(content);
    observer.observe(viewport);
    if (stage) observer.observe(stage);
    writeLatest();
    kick();
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [resetKey, stageRef, writeLatest]);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const nextTop = viewport.scrollTop;
    const nextHeight = viewport.clientHeight;
    const viewportResized = nextHeight !== previousHeightRef.current;
    const previousTop = previousTopRef.current;
    previousTopRef.current = nextTop;
    previousHeightRef.current = nextHeight;
    const settling = Date.now() < settleUntilRef.current;
    const nextPinned = nextConversationPinState({
      pinned: pinnedRef.current,
      previousTop,
      nextTop,
      gap: viewport.scrollHeight - nextTop - nextHeight,
      viewportResized,
      settling,
      programmatic: programmaticRef.current,
    });
    if (settling && nextPinned && pinnedRef.current && !programmaticRef.current) writeLatest();
    if (nextPinned !== pinnedRef.current) setPinned(nextPinned);
  }, [setPinned, writeLatest]);

  return { viewportRef, contentRef, pinnedToLatest, hasNewActivity, handleScroll, jumpToLatest, pinToLatest };
}
