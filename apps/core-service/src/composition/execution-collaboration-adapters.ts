import type { RunEventMap, RunEventType, TaskRun } from "@tagent/execution/domain";
import type { CoreApplicationPersistencePort } from "../application/ports/index.js";
import type {
  ContextEnrichmentPort,
  ExecutionBackgroundWorkPort,
  UserMessageObserverPort,
} from "@tagent/execution/composition";
import type { RuntimeMessage } from "@tagent/execution/ports";
import type { AccessContext, MemoryFacade } from "@tagent/memory";

interface ExecutionCollaborationAdapterOptions {
  persistence: Pick<CoreApplicationPersistencePort, "events" | "sessions" | "submissions" | "taskRuns">;
  memory?: MemoryFacade;
  memoryScopeId: string;
  publish<TType extends RunEventType>(runId: string, type: TType, data: RunEventMap[TType]): void;
}

export function resolveMemorySubjectId(
  persistence: Pick<CoreApplicationPersistencePort, "submissions">,
  sessionId: string,
): string {
  return persistence.submissions.getSessionPrincipalId(sessionId) ?? `session:${sessionId}`;
}

export interface ExecutionCollaborationAdapters {
  backgroundWork: ExecutionBackgroundWorkPort;
  contextEnrichment: ContextEnrichmentPort;
  userMessageObserver: UserMessageObserverPort;
}

const ONLINE_RECALL_DEADLINE_MS = 3_000;
const ONLINE_EMBEDDING_TIMEOUT_MS = 2_200;

export async function withinDeadline<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal.reason ?? new Error("memory recall cancelled"));
  signal.addEventListener("abort", abortFromCaller, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectOnAbort: (() => void) | undefined;
  let pending: Promise<T> | undefined;
  try {
    pending = work(controller.signal);
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        rejectOnAbort = () => reject(controller.signal.reason ?? new Error("memory recall cancelled"));
        controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
        timer = setTimeout(() => controller.abort(new Error(`online memory recall exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    // A deadline requests cooperative cancellation but never abandons
    // same-process work. The caller regains control only after ownership has
    // converged to a settled promise.
    if (pending) await Promise.allSettled([pending]);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (rejectOnAbort) controller.signal.removeEventListener("abort", rejectOnAbort);
    signal.removeEventListener("abort", abortFromCaller);
  }
}

export function createExecutionCollaborationAdapters(
  options: ExecutionCollaborationAdapterOptions,
): ExecutionCollaborationAdapters {
  const subjectId = (run: TaskRun) => resolveMemorySubjectId(options.persistence, run.sessionId);
  const access = (run: TaskRun, observedSubjectId = subjectId(run)): AccessContext => ({
    subjectId: observedSubjectId,
    scopes: memoryScopes(observedSubjectId, options.memoryScopeId, run.sessionId),
    purpose: "agent_recall",
  });
  const capturePrunedUserContext = (run: TaskRun, messages: RuntimeMessage[]) => {
    if (!options.memory) return;
    const durable = messages
      .filter((message) => message.role === "user")
      .flatMap((message) => summarizeDurableUserContext(memoryMessageText(message)))
      .slice(-20);
    if (!durable.length) return;
    const summary = durable.map((text) => `user: ${text}`).join("\n");
    const fingerprint = stableTextHash(summary);
    void options.memory.enqueueCapture({
      access: { ...access(run), purpose: "capture" },
      sourceRefs: [{ sourceType: "transcript", sourceId: run.id, revision: `context-prune:${run.attempt}:${fingerprint}` }],
      content: summary,
      idempotencyKey: `context-prune:${run.id}:${run.attempt}:${fingerprint}`,
      captureSource: { kind: "context_summary", role: "user" },
    }).then(({ jobId }) => options.publish(run.id, "memory.capture.queued", {
      jobId,
      sourceType: "user_context_summary",
    })).catch((error: unknown) => options.publish(run.id, "memory.capture.failed", {
      sourceType: "user_context_summary",
      error: error instanceof Error ? error.message : String(error),
    }));
  };

  return {
    backgroundWork: {
      start() {},
    },
    contextEnrichment: {
      requiresAsyncPreparation: () => Boolean(options.memory),
      prepareWithoutRecall() {
        return { promptSection: "", contextItems: [] };
      },
      async enrich(run, query, signal) {
        signal.throwIfAborted();
        const memoryAccess = access(run);
        let recall: Awaited<ReturnType<MemoryFacade["recall"]>> | undefined;
        let coreSnapshots: Array<NonNullable<Awaited<ReturnType<NonNullable<MemoryFacade["getCoreSnapshot"]>>>>> = [];
        if (options.memory) {
          try {
            [recall, coreSnapshots] = await withinDeadline((deadlineSignal) => Promise.all([
              options.memory!.recall({ access: memoryAccess, cue: query, embeddingTimeoutMs: ONLINE_EMBEDDING_TIMEOUT_MS, signal: deadlineSignal }),
              Promise.all(memoryAccess.scopes.map((scope) => options.memory!.getCoreSnapshot?.({ ...memoryAccess, scopes: [scope] }, deadlineSignal)))
                .then((snapshots) => snapshots.filter((snapshot): snapshot is NonNullable<typeof snapshot> => Boolean(snapshot))),
            ]), ONLINE_RECALL_DEADLINE_MS, signal);
          } catch (error) {
            if (signal.aborted) throw signal.reason ?? error;
            options.publish(run.id, "memory.recall.degraded", {
              reason: "online_deadline",
              timeoutMs: ONLINE_RECALL_DEADLINE_MS,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        signal.throwIfAborted();
        const coreSection = coreSnapshots.map((snapshot) => `<core_memory scope="${snapshot.scope.type}:${snapshot.scope.id}" revision="${snapshot.revision}">\n${snapshot.markdown}\n</core_memory>`).join("\n\n");
        return {
          promptSection: [coreSection, recall?.promptSection]
            .filter(Boolean)
            .join("\n\n"),
          contextItems: [
            ...coreSnapshots.map((coreSnapshot) => ({
              kind: "core_memory" as const,
              sourceId: `${coreSnapshot.scope.type}:${coreSnapshot.scope.id}:revision:${coreSnapshot.revision}`,
              selected: true,
              reason: "stable core-memory injection",
              estimatedTokens: coreSnapshot.tokenCount,
              metadata: { revision: coreSnapshot.revision, sourceRecordIds: coreSnapshot.sourceRecordIds },
            })),
            ...(recall?.cards.map((card) => ({
              kind: "memory_card" as const,
              sourceId: card.id,
              selected: true,
              reason: `selected by Recall Trace v${recall.trace.version}`,
              estimatedTokens: estimateContextTokens(`${card.title}: ${card.content}`),
              metadata: { score: card.score, channels: card.retrievalChannels, topicIds: card.topicIds },
            })) ?? []),
            ...(recall?.coldTopics.map((topic) => ({
              kind: "cold_topic" as const,
              sourceId: topic.descriptor.topicId,
              selected: true,
              reason: "selected by topic routing",
              estimatedTokens: topic.revision.tokenCount,
              metadata: { revision: topic.revision.revision },
            })) ?? []),
            ...(recall?.trace?.candidates?.filter((candidate) => candidate.outcome !== "selected").map((candidate) => ({
              kind: "memory_card" as const,
              sourceId: candidate.id,
              selected: false,
              reason: candidate.reason ?? candidate.outcome,
              estimatedTokens: 0,
              metadata: { outcome: candidate.outcome, channels: candidate.channels, finalScore: candidate.finalScore },
            })) ?? []),
          ],
        };
      },
      capturePrunedUserContext,
    },
    userMessageObserver: {
      observe({ run, messageId, content, context, subjectId: observedSubjectId }) {
        const messageSubjectId = observedSubjectId ?? subjectId(run);
        if (!options.memory) return;
        void options.memory.enqueueCapture({
          access: { ...access(run, messageSubjectId), purpose: "capture" },
          sourceRefs: [{ sourceType: "message", sourceId: String(messageId), revision: "user" }],
          content: `<context>\n${context}\n</context>\n<focus_user>\n${content}\n</focus_user>`,
          idempotencyKey: `user-message:${messageId}`,
          captureSource: { kind: "user_message", role: "user" },
        }).then(({ jobId }) => options.publish(run.id, "memory.capture.queued", {
          jobId,
          sourceType: "message",
          sourceId: String(messageId),
        })).catch((error: unknown) => options.publish(run.id, "memory.capture.failed", {
          sourceType: "message",
          sourceId: String(messageId),
          error: error instanceof Error ? error.message : String(error),
        }));
      },
    },
  };
}

function memoryMessageText(message: RuntimeMessage) {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.type === "text" ? part.text : "")
    .join("\n")
    .trim();
}

function summarizeDurableUserContext(text: string) {
  return text.split(/\n+|(?<=[。！？.!?])\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2
      && !/[?？]$/.test(part)
      && !/^(?:请|帮我|麻烦|检查|审计|排查|修复|实现|运行|执行|部署|合并|查看|确认|分析|调查)/i.test(part)
      && /(?:记住|我叫|我的名字|叫我|称呼我|我.{0,20}(?:喜欢|偏好|希望|不喜欢|习惯)|我们(?:已经|已)?(?:决定|确定|采用|改为|迁移)|以后|始终|必须|住在|家在|是邻居|my name|call me|i prefer|we decided|from now on)/i.test(part));
}

function stableTextHash(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(16);
}

function memoryScopes(subjectId: string, workspaceId: string, sessionId: string): AccessContext["scopes"] {
  const shared = [
    { type: "workspace" as const, id: workspaceId },
    { type: "session" as const, id: sessionId },
  ];
  return subjectId === `session:${sessionId}`
    ? shared
    : [{ type: "user", id: subjectId }, ...shared];
}

function estimateContextTokens(text: string) {
  if (!text) return 0;
  let nonAscii = 0;
  for (const character of text) if (character.charCodeAt(0) > 127) nonAscii += 1;
  return Math.max(1, Math.ceil(nonAscii * 1.5 + (text.length - nonAscii) * 0.25));
}
