import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { api, type Message } from "./api";

const MESSAGE_PAGE_SIZE = 80;

export function messagePageHasOlderHint(messages: readonly Message[]): boolean {
  return messages.length === MESSAGE_PAGE_SIZE;
}

export interface ConversationHistoryTicket {
  workspaceId: string;
  generation: number;
}

export class ConversationHistoryAuthority {
  private workspaceId = "";
  private generation = 0;

  enter(workspaceId: string): void {
    if (workspaceId === this.workspaceId) return;
    this.workspaceId = workspaceId;
    this.generation += 1;
  }

  capture(workspaceId: string): ConversationHistoryTicket | null {
    return workspaceId && workspaceId === this.workspaceId
      ? { workspaceId, generation: this.generation }
      : null;
  }

  isCurrent(ticket: ConversationHistoryTicket): boolean {
    return ticket.workspaceId === this.workspaceId && ticket.generation === this.generation;
  }
}

export function mergeEarlierMessages(current: readonly Message[], earlier: readonly Message[]): Message[] {
  const currentIds = new Set(current.map((message) => message.id));
  return [...earlier.filter((message) => !currentIds.has(message.id)), ...current];
}

export function useConversationHistory({
  workspaceId,
  viewportRef,
  onEarlierHistory,
  onError,
}: {
  workspaceId: string;
  viewportRef: RefObject<HTMLElement | null>;
  onEarlierHistory: () => void;
  onError: (message: string) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const authorityRef = useRef(new ConversationHistoryAuthority());
  const loadingRef = useRef(false);
  authorityRef.current.enter(workspaceId);

  useEffect(() => {
    loadingRef.current = false;
    setLoadingOlderMessages(false);
  }, [workspaceId]);

  const loadOlderMessages = useCallback(async () => {
    if (!workspaceId || loadingRef.current || !messages.length) return;
    const ticket = authorityRef.current.capture(workspaceId);
    if (!ticket) return;
    const targetWorkspaceId = workspaceId;
    const viewport = viewportRef.current;
    const previousHeight = viewport?.scrollHeight ?? 0;
    loadingRef.current = true;
    setLoadingOlderMessages(true);
    try {
      const earlier = await api.messages(targetWorkspaceId, MESSAGE_PAGE_SIZE, messages[0].id);
      if (!authorityRef.current.isCurrent(ticket)) return;
      setMessages((current) => mergeEarlierMessages(current, earlier));
      setHasOlderMessages(messagePageHasOlderHint(earlier));
      if (earlier.length) onEarlierHistory();
      requestAnimationFrame(() => {
        if (viewport && authorityRef.current.isCurrent(ticket)) {
          viewport.scrollTop += viewport.scrollHeight - previousHeight;
        }
      });
    } catch (cause) {
      if (authorityRef.current.isCurrent(ticket)) onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (authorityRef.current.isCurrent(ticket)) {
        loadingRef.current = false;
        setLoadingOlderMessages(false);
      }
    }
  }, [messages, onEarlierHistory, onError, viewportRef, workspaceId]);

  return {
    messages,
    setMessages,
    hasOlderMessages,
    setHasOlderMessages,
    loadingOlderMessages,
    loadOlderMessages,
  };
}
