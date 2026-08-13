import type { AgentServicePersistencePort } from "../application/ports/index.js";
import type { RunEvent, RunEventMap, RunEventType, TaskRun } from "@tagent/execution/domain";
import type {
  ArtifactSinkPort,
  AttemptExecutionToken,
  FencedRuntimeMutationContext,
  RuntimeCapabilityCatalog,
  RuntimeEventSink,
  RuntimeMessage,
  ToolCapabilityApplicationPort,
  WorkspaceEditPort,
} from "@tagent/execution/ports";
import type { AccessContext, MemoryFacade, MemoryKind } from "@tagent/memory";
import { effectiveTaskExecutionPolicy } from "@tagent/governance/domain";
import { composeWorkspaceTools } from "@tagent/workspace-local/tools";
import { createLocalSubprocessPort } from "@tagent/workspace-local/local-subprocess";

export interface RuntimeHostOptions {
  persistence: Pick<
    AgentServicePersistencePort,
    "attempts" | "runtime" | "runtimeMutations" | "taskRuns" | "workspaceGoals"
    | "approvals"
  >;
  token: AttemptExecutionToken;
  workspace: string;
  onActivity: () => void;
  onEvent: (event: RunEvent) => void;
  memory?: MemoryFacade;
  memoryScopeId: string;
  memorySubjectId: string;
  artifactSink?: ArtifactSinkPort;
  workspaceEdit?: WorkspaceEditPort;
}

export interface RuntimeHost {
  capabilities: RuntimeCapabilityCatalog;
  eventSink: RuntimeEventSink;
  dispose(): Promise<void> | void;
}

export function createRuntimeHost(options: RuntimeHostOptions): RuntimeHost {
  const { persistence, token } = options;
  const atomicallySettledToolCalls = new Set<string>();
  const mutationContext: Readonly<FencedRuntimeMutationContext> = Object.freeze({
    attemptId: token.attemptId,
    expectedVersion: token.expectedVersion,
    leaseToken: token.leaseToken,
    fence: token.executionFence,
  });
  const currentAttempt = () => {
    const attempt = persistence.attempts.getAttempt(token.attemptId);
    if (!attempt || attempt.runId !== token.runId || attempt.ordinal !== token.ordinal
      || attempt.version !== token.expectedVersion || !attempt.active || attempt.status !== "running") {
      return undefined;
    }
    return attempt;
  };
  const currentRun = (): TaskRun | undefined => {
    if (!currentAttempt()) return undefined;
    const run = persistence.taskRuns.getRun(token.runId);
    return run?.attempt === token.ordinal ? run : undefined;
  };
  const currentRunExecutionState = () => {
    if (!currentAttempt()) return undefined;
    const state = persistence.taskRuns.getRunExecutionState?.(token.runId);
    if (state) return state.attempt === token.ordinal ? state : undefined;
    const run = persistence.taskRuns.getRun(token.runId);
    return run?.attempt === token.ordinal ? {
      id: run.id, status: run.status, phase: run.phase, attempt: run.attempt,
      lastEventSeq: run.lastEventSeq,
      counts: { plan: run.plan.length, checks: run.checks.length, artifacts: run.artifacts.length },
    } : undefined;
  };
  const waitingRun = (): TaskRun | undefined => {
    const attempt = persistence.attempts.getAttempt(token.attemptId);
    if (!attempt || attempt.runId !== token.runId || attempt.ordinal !== token.ordinal
      || attempt.version !== token.expectedVersion + 1 || attempt.active || attempt.status !== "waiting_input") {
      return undefined;
    }
    const run = persistence.taskRuns.getRun(token.runId);
    return run?.attempt === token.ordinal && run.status === "waiting_input" ? run : undefined;
  };
  const publish = <TType extends RunEventType>(type: TType, data: RunEventMap[TType]): RunEvent<TType> | undefined => {
    if (!currentAttempt()) return undefined;
    const event = persistence.runtimeMutations.appendEvent(mutationContext, type, data);
    options.onEvent(event);
    return event as RunEvent<TType>;
  };
  const memorySessionId = currentRun()?.sessionId;
  const memoryAccess: AccessContext = {
    subjectId: options.memorySubjectId,
    scopes: [
      ...(options.memorySubjectId === `session:${memorySessionId}` ? [] : [{ type: "user" as const, id: options.memorySubjectId }]),
      { type: "workspace", id: options.memoryScopeId },
      ...(memorySessionId ? [{ type: "session" as const, id: memorySessionId }] : []),
    ],
    purpose: "agent_recall",
  };
  const toolCapabilities: ToolCapabilityApplicationPort = {
    runId: token.runId,
    artifactSink: options.artifactSink,
    workspaceEdit: options.workspaceEdit,
    getRun: currentRun,
    getRunExecutionState: currentRunExecutionState,
    isCurrentAttempt: () => Boolean(currentAttempt()),
    authorizeWorkspaceMutation: () => persistence.workspaceGoals.authorizeRunMutation(token.runId),
    authorizeExternalAction: () => effectiveTaskExecutionPolicy(currentRun()?.contract ?? null).mode === "external_action"
      ? persistence.approvals.authorizeExternalAction(token.runId, token.ordinal)
      : { allowed: true, reason: "TaskRun does not require external-action approval" },
    advanceRunPhase: (phase) => persistence.runtimeMutations.advanceRunPhase(mutationContext, phase),
    setRunPhase: (phase) => persistence.runtimeMutations.setRunPhase(mutationContext, phase),
    claimOperation: (id, operationType, payload) => persistence.runtimeMutations.claimOperation(mutationContext, id, operationType, payload),
    updateOperation: (id, update) => persistence.runtimeMutations.updateOperation(mutationContext, id, update),
    listOperations: (query) => persistence.runtime.listOperations(token.runId, query),
    upsertPlanItem: (item) => persistence.runtimeMutations.upsertPlanItem(mutationContext, item),
    markChecksStale: () => persistence.runtimeMutations.markChecksStale(mutationContext),
    upsertCheck: (check) => persistence.runtimeMutations.upsertCheck(mutationContext, check),
    applyTaskRunBatch: (mutations) => persistence.runtimeMutations.applyTaskRunBatch(mutationContext, mutations),
    addArtifact: (artifact) => persistence.runtimeMutations.addArtifact(mutationContext, artifact),
    requestUserInput: (toolCallId, prompt, fields) => {
      const { request, event, toolAttemptCompleted } = persistence.runtimeMutations.requestUserInput(
        mutationContext,
        prompt,
        fields,
        toolCallId,
      );
      if (toolAttemptCompleted) atomicallySettledToolCalls.add(toolCallId);
      options.onEvent(event);
      return request;
    },
    recordToolAttempt: (toolCallId, toolName, args) => persistence.runtimeMutations.recordToolAttempt(
      mutationContext, toolCallId, toolName, args,
    ),
    completeToolAttempt: (toolCallId, success, error) => persistence.runtimeMutations.completeToolAttempt(
      mutationContext, toolCallId, success, error,
    ),
    consumeAtomicallySettledToolCall: (toolCallId) => atomicallySettledToolCalls.delete(toolCallId),
    publish,
    memory: options.memory ? {
      search: async (query, kinds, maxResults) => {
        const result = await options.memory!.recall({
          access: memoryAccess,
          cue: query,
          kinds: kinds as MemoryKind[] | undefined,
          maxCards: maxResults ?? 8,
          maxColdTopics: 0,
        });
        return { cards: result.cards, topicIds: result.trace.topicIds, trace: result.trace };
      },
      getTopic: async (topicId) => {
        const topic = await options.memory!.getColdTopic(memoryAccess, topicId);
        return topic ? {
          body: topic.body,
          revision: topic.revision.revision,
          checksum: topic.revision.checksum,
        } : undefined;
      },
      getRecord: (id) => options.memory!.getRecord(memoryAccess, id),
      forget: (input) => options.memory!.forget({
        access: { ...memoryAccess, purpose: "memory_admin" },
        scope: { type: "workspace", id: options.memoryScopeId },
        ...input,
      }),
    } : undefined,
  };
  const subprocess = createLocalSubprocessPort();
  const toolComposition = composeWorkspaceTools(toolCapabilities, options.workspace, subprocess);
  const eventSink: RuntimeEventSink = {
    activity: options.onActivity,
    publish,
    appendTranscript: (message: RuntimeMessage) => currentAttempt()
      ? persistence.runtimeMutations.appendTranscript(mutationContext, message)
      : undefined,
    isRunning: () => Boolean(currentAttempt()),
    isWaitingForInput: () => Boolean(waitingRun()),
    beforeToolCall: ({ toolCallId, toolName, args }) => toolComposition.pipeline.beforeToolCall(toolCallId, toolName, args),
    afterToolCall: ({ toolCallId, success, error }) => toolComposition.pipeline.afterToolCall(toolCallId, success, error),
  };
  return {
    capabilities: toolComposition.catalog,
    eventSink,
    dispose: () => subprocess.dispose?.(),
  };
}
