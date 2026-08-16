import { api, drainTranscriptView, type Message, type SessionInboxItem, type TaskRun, type TaskRunSummary, type TranscriptItem } from "./api";
import { preloadMarkdown } from "./LazyMarkdown";
import { findActiveRun } from "./run-state";

export type WorkspaceSnapshot = {
  sessionId: string;
  history: Message[];
  runHistory: TaskRunSummary[];
  queued: SessionInboxItem[];
  active: TaskRun | null;
  latest: TaskRun | null;
  transcript: TranscriptItem[];
  transcriptAfter: number;
};

export async function loadWorkspaceSnapshot(sessionId: string): Promise<WorkspaceSnapshot> {
  const [history, runHistory, queued] = await Promise.all([api.messages(sessionId), api.runs(sessionId), api.inbox(sessionId)]);
  if (history.some((message) => message.content.trim())) void preloadMarkdown().catch(() => undefined);
  const latestSummary = runHistory[0] ?? null;
  const activeSummary = findActiveRun(runHistory);
  const runIds = [...new Set([latestSummary?.id, activeSummary?.id].filter((value): value is string => Boolean(value)))];
  const hydrated = new Map(await Promise.all(runIds.map(async (runId) => [runId, await api.run(runId)] as const)));
  const latest = latestSummary ? hydrated.get(latestSummary.id) ?? null : null;
  const active = activeSummary ? hydrated.get(activeSummary.id) ?? null : null;
  const transcriptView = latest ? await drainTranscriptView(latest.id, latest.transcriptCount) : { items: [] as TranscriptItem[], after: 0 };
  const transcript = transcriptView.items;
  const transcriptHasRichText = transcript.some((item) => (item.kind === "assistant" || item.kind === "thinking") && item.text.trim());
  if (transcriptHasRichText) void preloadMarkdown().catch(() => undefined);
  return { sessionId, history, runHistory, queued, active, latest, transcript, transcriptAfter: transcriptView.after };
}
