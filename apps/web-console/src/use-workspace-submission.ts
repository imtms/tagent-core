import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api, type GateProfile, type Message, type SessionInboxItem, type TaskRun } from "./api";
import { preloadMarkdown } from "./markdown-loader";
import type { PendingUserMessage } from "./use-workspace-live-sync";

interface SubmissionAuthority {
  workspaceId: string;
  generation: number;
}

export function hasPersistedSubmission(
  messages: readonly Message[],
  submission: PendingUserMessage,
): boolean {
  return messages.some((message) => message.role === "user"
    && message.content === submission.content
    && message.createdAt >= submission.createdAt - 5_000);
}

export function useWorkspaceSubmission({
  workspaceId,
  draft,
  gateProfile,
  recordSubmission,
  restoreDraft,
  pinToLatest,
  setInbox,
  setMessages,
  setHasOlderMessages,
  setPendingUserMessage,
  startRun,
  setError,
  setNotice,
}: {
  workspaceId: string;
  draft: string;
  gateProfile: GateProfile;
  recordSubmission: (content: string) => void;
  restoreDraft: (content: string) => void;
  pinToLatest: () => void;
  setInbox: Dispatch<SetStateAction<SessionInboxItem[]>>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setHasOlderMessages: Dispatch<SetStateAction<boolean>>;
  setPendingUserMessage: Dispatch<SetStateAction<PendingUserMessage | null>>;
  startRun: (run: TaskRun) => void;
  setError: Dispatch<SetStateAction<string>>;
  setNotice: Dispatch<SetStateAction<string>>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const authorityRef = useRef<SubmissionAuthority>({ workspaceId, generation: 0 });

  useLayoutEffect(() => {
    authorityRef.current = {
      workspaceId,
      generation: authorityRef.current.generation + 1,
    };
    setSubmitting(false);
  }, [workspaceId]);

  const isCurrent = useCallback((authority: SubmissionAuthority) => {
    const current = authorityRef.current;
    return current.workspaceId === authority.workspaceId && current.generation === authority.generation;
  }, []);

  const submit = useCallback(async () => {
    const content = draft.trim();
    const authority = { ...authorityRef.current };
    if (!content || !authority.workspaceId || submitting) return;

    void preloadMarkdown().catch(() => undefined);
    const optimistic: PendingUserMessage = {
      workspaceId: authority.workspaceId,
      content,
      createdAt: Date.now(),
    };
    setSubmitting(true);
    recordSubmission(content);
    setError("");
    setNotice("");
    pinToLatest();

    try {
      const admission = await api.send(authority.workspaceId, content, gateProfile);
      if (!isCurrent(authority)) return;
      if (admission.run) setPendingUserMessage(optimistic);

      const [queued, history] = await Promise.all([
        api.inbox(authority.workspaceId),
        api.messages(authority.workspaceId),
      ]);
      if (!isCurrent(authority)) return;

      setInbox(queued);
      setMessages(history);
      setHasOlderMessages(history.length === 80);
      setPendingUserMessage(hasPersistedSubmission(history, optimistic)
        ? null
        : admission.run ? optimistic : null);
      if (admission.run) startRun(admission.run);
    } catch (cause) {
      if (!isCurrent(authority)) return;
      setPendingUserMessage(null);
      restoreDraft(content);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrent(authority)) setSubmitting(false);
    }
  }, [draft, gateProfile, isCurrent, pinToLatest, recordSubmission, restoreDraft, setError, setHasOlderMessages, setInbox, setMessages, setNotice, setPendingUserMessage, startRun, submitting]);

  return { submitting, submit };
}
