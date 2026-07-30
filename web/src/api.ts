import { createRequestId } from "./id";

export interface Session { id: string; title: string; createdAt: number; updatedAt: number }
export interface Message { id: number; sessionId: string; role: "user" | "assistant" | "tool"; content: string; createdAt: number }
export interface PlanItem { key: string; title: string; status: string; required: boolean; position: number }
export interface RunCheck { key: string; title: string; status: string; required: boolean; command: string; evidence: string; stale: boolean }
export interface TaskRun {
  id: string; sessionId: string; requestId: string; status: string; phase: string; goal: string;
  blockedReason: string; lastEventSeq: number; attempt: number; resumedAt: number | null; createdAt: number; updatedAt: number; completedAt: number | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };
  transcriptCount: number;
  checkpoint: { runId: string; attempt: number; active: boolean; assistantPartial: string; currentTool: { toolCallId: string; toolName: string } | null; lastEventSeq: number; lastTranscriptSeq: number; updatedAt: number } | null;
  continuations: Array<{ id: string; ordinal: number; status: string; reason: string; error: string; createdAt: number; startedAt: number | null; completedAt: number | null; leaseOwner: string; leaseUntil: number | null; heartbeatAt: number | null }>;
  plan: PlanItem[]; checks: RunCheck[];
  artifacts: Array<{ id: string; title: string; kind: string; uri: string }>;
  budget?: { tier: string; maxContinuations: number; maxTokens: number; runTimeoutMs: number };
  completionGate: { passed: boolean; failures: Array<{ kind: string; key: string; reason: string }> };
}
export interface RunEvent { runId: string; seq: number; type: string; data: Record<string, unknown>; createdAt: number }
export type TranscriptItem =
  | { seq: number; index?: number; attempt: number; kind: "user" | "assistant"; text: string; createdAt: number }
  | { seq: number; index: number; attempt: number; kind: "tool"; toolCallId: string; toolName: string; arguments: unknown; result: string; isError: boolean; status: string; createdAt: number };
export interface RuntimeStatus { runtime: string; provider: string; api: string; baseUrl: string; modelId: string; credentialConfigured: boolean; providerTimeoutMs: number; providerMaxRetries: number; runTimeoutMs: number; maxContinuations: number; maxRunTokens: number; dynamicBudget: boolean; schemaVersion?: number }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? response.statusText);
  return response.json() as Promise<T>;
}

export const api = {
  status: () => request<RuntimeStatus | null>("/api/config/status"),
  sessions: () => request<Session[]>("/api/sessions"),
  createSession: (title = "New workspace") => request<Session>("/api/sessions", { method: "POST", body: JSON.stringify({ title }) }),
  messages: (sessionId: string) => request<Message[]>(`/api/sessions/${sessionId}/messages`),
  runs: (sessionId: string, limit = 50) => request<TaskRun[]>(`/api/sessions/${sessionId}/runs?limit=${limit}`),
  latestRun: (sessionId: string) => request<TaskRun | null>(`/api/sessions/${sessionId}/run`),
  run: (runId: string) => request<TaskRun>(`/api/runs/${runId}`),
  transcriptView: (runId: string) => request<TranscriptItem[]>(`/api/runs/${runId}/transcript-view`),
  send: (sessionId: string, content: string) => request<TaskRun>(`/api/sessions/${sessionId}/messages`, { method: "POST", body: JSON.stringify({ content, requestId: createRequestId() }) }),
  cancel: (runId: string) => request(`/api/runs/${runId}/cancel`, { method: "POST" }),
  steer: (runId: string, content: string) => request(`/api/runs/${runId}/steer`, { method: "POST", body: JSON.stringify({ content }) }),
  resume: (runId: string) => request<TaskRun>(`/api/runs/${runId}/resume`, { method: "POST" }),
};

export function subscribe(runId: string, after: number, onEvent: (event: RunEvent) => void, onError: () => void) {
  const source = new EventSource(`/api/runs/${runId}/events?after=${after}`);
  source.onmessage = (message) => onEvent(JSON.parse(message.data) as RunEvent);
  source.onerror = onError;
  return () => source.close();
}
