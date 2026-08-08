import type { TaskRun } from "@tagent/execution/domain";
import type { AgentServicePersistencePort } from "../application/ports/index.js";
import type {
  AttemptProjectionPort,
  ContextEnrichmentPort,
  ExecutionBackgroundWorkPort,
  UserMessageObserverPort,
} from "@tagent/execution/composition";
import type { RuntimeMessage } from "@tagent/execution/ports";
import type {
  LearningFeatureControl,
  LearningService,
  WorkflowService,
} from "@tagent/learning";
import type { AccessContext, MemoryFacade, MemoryProvenance } from "@tagent/memory";

interface ExecutionCollaborationAdapterOptions {
  persistence: Pick<AgentServicePersistencePort, "events" | "sessions" | "taskRuns">;
  memory?: MemoryFacade;
  memoryScopeId: string;
  learningControl?: LearningFeatureControl;
  learningService: LearningService;
  workflowService: WorkflowService;
  publish(runId: string, type: string, data: Record<string, unknown>): void;
}

export interface ExecutionCollaborationAdapters {
  backgroundWork: ExecutionBackgroundWorkPort;
  contextEnrichment: ContextEnrichmentPort;
  projection: AttemptProjectionPort;
  userMessageObserver: UserMessageObserverPort;
}

const ONLINE_RECALL_DEADLINE_MS = 3_000;
const ONLINE_EMBEDDING_TIMEOUT_MS = 2_200;

async function withinDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`online memory recall exceeded ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createExecutionCollaborationAdapters(
  options: ExecutionCollaborationAdapterOptions,
): ExecutionCollaborationAdapters {
  const learningEnabled = () => options.learningControl?.snapshot().learningEnabled ?? true;
  const access = (run: TaskRun): AccessContext => ({
    subjectId: `session:${run.sessionId}`,
    scopes: [
      { type: "workspace", id: options.memoryScopeId },
      { type: "session", id: run.sessionId },
    ],
    purpose: "agent_recall",
  });
  const learningContext = (run: TaskRun, query: string) => {
    const workflows = options.workflowService.recall(run.sessionId, query, run.id, run.attempt);
    const profile = learningEnabled()
      ? options.learningService.resolveCommunicationProfile(`session:${run.sessionId}`, [
          { type: "workspace", id: options.memoryScopeId },
          { type: "session", id: run.sessionId },
          { type: "task", id: run.id },
        ])
      : { promptSection: "", contextItems: [] };
    return { workflows, profile };
  };
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
      access: access(run),
      sourceRefs: [{ sourceType: "transcript", sourceId: run.id, revision: `context-prune:${run.attempt}:${fingerprint}` }],
      content: summary,
      idempotencyKey: `context-prune:${run.id}:${run.attempt}:${fingerprint}`,
      provenance: userContextSummaryProvenance,
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
      start() {
        if (!learningEnabled()) return;
        options.learningService.drainLearningProjectionLedger();
        void options.workflowService.drainSemanticLearningJobs();
        void options.learningService.drainSemanticLearningJobs();
        void options.learningService.drainFeedbackAttribution();
      },
    },
    contextEnrichment: {
      requiresAsyncPreparation: () => Boolean(options.memory),
      prepareWithoutRecall(run, query) {
        const { workflows, profile } = learningContext(run, query);
        return {
          promptSection: [profile.promptSection, workflows.promptSection].filter(Boolean).join("\n\n"),
          contextItems: [...profile.contextItems, ...workflows.contextItems],
        };
      },
      async enrich(run, query) {
        const memoryAccess = access(run);
        let recall: Awaited<ReturnType<MemoryFacade["recall"]>> | undefined;
        let coreSnapshot: Awaited<ReturnType<NonNullable<MemoryFacade["getCoreSnapshot"]>>> | undefined;
        if (options.memory) {
          try {
            [recall, coreSnapshot] = await withinDeadline(Promise.all([
              options.memory.recall({ access: memoryAccess, cue: query, embeddingTimeoutMs: ONLINE_EMBEDDING_TIMEOUT_MS }),
              options.memory.getCoreSnapshot?.(memoryAccess),
            ]), ONLINE_RECALL_DEADLINE_MS);
          } catch (error) {
            options.publish(run.id, "memory.recall.degraded", {
              reason: "online_deadline",
              timeoutMs: ONLINE_RECALL_DEADLINE_MS,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const { workflows, profile } = learningContext(run, query);
        const coreSection = coreSnapshot?.markdown
          ? `<core_memory revision="${coreSnapshot.revision}">\n${coreSnapshot.markdown}\n</core_memory>`
          : "";
        return {
          promptSection: [coreSection, profile.promptSection, recall?.promptSection, workflows.promptSection]
            .filter(Boolean)
            .join("\n\n"),
          contextItems: [
            ...(coreSnapshot?.markdown ? [{
              kind: "core_memory" as const,
              sourceId: `${coreSnapshot.scope.type}:${coreSnapshot.scope.id}:revision:${coreSnapshot.revision}`,
              selected: true,
              reason: "stable core-memory injection",
              estimatedTokens: coreSnapshot.tokenCount,
              metadata: { revision: coreSnapshot.revision, sourceRecordIds: coreSnapshot.sourceRecordIds },
            }] : []),
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
            ...profile.contextItems,
            ...workflows.contextItems,
          ],
        };
      },
      capturePrunedUserContext,
    },
    projection: {
      project(runId) {
        if (!learningEnabled()) return;
        const run = options.persistence.taskRuns.getRun(runId);
        if (!run) return;
        try {
          options.workflowService.recordRunApplications(run);
          options.workflowService.recordCanaryOutcome(run);
          void options.workflowService.drainSemanticLearningJobs();
          options.learningService.drainLearningProjectionLedger();
          options.learningService.projectRun(run);
          void options.learningService.drainSemanticLearningJobs()
            .then(() => options.learningService.drainFeedbackAttribution())
            .catch((error: unknown) => options.publish(runId, "memory.feedback.attribution.failed", {
              error: error instanceof Error ? error.message : String(error),
            }));
        } catch (error) {
          options.publish(runId, "workflow.learning.failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    userMessageObserver: {
      observe({ run, messageId, content, context }) {
        if (learningEnabled()) {
          options.learningService.enqueueUserMessageAnalysis({
            subjectId: `session:${run.sessionId}`,
            scopeId: run.sessionId,
            messageId,
            content,
            context,
            runId: run.id,
            attempt: run.attempt,
          });
          void options.learningService.drainSemanticLearningJobs();
        }
        if (!options.memory) return;
        void options.memory.enqueueCapture({
          access: access(run),
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

function estimateContextTokens(text: string) {
  if (!text) return 0;
  let nonAscii = 0;
  for (const character of text) if (character.charCodeAt(0) > 127) nonAscii += 1;
  return Math.max(1, Math.ceil(nonAscii * 1.5 + (text.length - nonAscii) * 0.25));
}

const userContextSummaryProvenance: MemoryProvenance = {
  evidenceClass: "user_context_summary",
  trustLevel: "medium",
  sourceRole: "user",
  verificationState: "structured",
};
