import { createInProcessRuntime } from "@tagent/runtime-pi/factory";
import {
  OpenAiResponseHeaderTimeoutError,
  readOpenAiChatContent,
  type OpenAiUsage,
} from "./openai-sse.js";
import { TaskRunSupervisor } from "./supervisor.js";
import {
  OpenAiSupervisorReviewer,
  SupervisorReviewError,
  TestSupervisorReviewer,
} from "./supervisor-reviewer.js";
import {
  SessionInputRouter,
  type SessionInputModelPort,
} from "@tagent/admission/composition";
import { AdmissionCoordinator } from "@tagent/admission";
import {
  AttemptExecutor,
  AttemptSettlementService,
  ContinuationScheduler,
  ControlInboxDispatcher,
  ExecutionCoordinator,
  ExecutionLifecycleService,
  ExecutionState,
  RecoveryCoordinator,
  RunContextService,
  RunEventHub,
  RuntimeRegistry,
  createOneShotPort,
  type AttemptLauncherPort,
  type AttemptSettlementPort,
  type ContinuationControlPort,
  type ExecutionCoordinatorStartupOptions,
  type ExecutionRuntimeDefaults,
  type RecoveryControlPort,
  type RunContextPort,
  type SupervisorPort,
} from "@tagent/execution/composition";
import type { AttemptRuntimeFactory, CredentialResolverPort, CredentialReference, RuntimeModelSpec } from "@tagent/execution/ports";
import { createRuntimeHost, type AdditionalToolProviderFactory } from "./runtime-host-adapter.js";
import { createProjectContextSource } from "@tagent/workspace-local/project-context";
import { createWorkspaceArtifactSink } from "@tagent/workspace-local/artifact-file-sink";
import { createWorkspaceEditPort } from "@tagent/workspace-local/snapshot-edit";
import type { AdmissionDispatchPort } from "@tagent/admission/composition";
import type { CoreApplicationPersistencePort } from "../application/ports/index.js";
import type { MemoryFacade } from "@tagent/memory";
import type { SupervisorReviewer } from "./supervisor-reviewer.js";
import { createExecutionCollaborationAdapters, resolveMemorySubjectId } from "./execution-collaboration-adapters.js";
import {
  createCoreApplicationCoordinator,
  type CoreApplicationCoordinator,
} from "../application/core-application-coordinator.js";
import { CoreWorkspaceGoalApplication, type WorkspaceGoalRoadmapGenerator } from "../application/workspace-goal-application.js";
import { OpenAiWorkspaceGoalRoadmapGenerator } from "./workspace-goal-roadmap-generator.js";
import { CoreSkillApplication } from "../application/skill-application.js";

export type CoreRuntimeDefaults = ExecutionRuntimeDefaults & {
  routerModel?: RuntimeModelSpec;
  routerTimeoutMs?: number;
  supervisorModel?: RuntimeModelSpec;
  supervisorTimeoutMs?: number;
  supervisorReviewer?: SupervisorReviewer;
  workspaceGoalRoadmapGenerator?: WorkspaceGoalRoadmapGenerator;
};

export interface ExecutionCompositionOptions {
  persistence: CoreApplicationPersistencePort;
  workspace: string;
  runtimeFactory?: AttemptRuntimeFactory;
  runtimeDefaults?: CoreRuntimeDefaults;
  memory?: MemoryFacade;
  memoryScopeId?: string;
  projectRuleFiles?: string[];
  toolArtifactMaxBytes?: number;
  startupOptions?: ExecutionCoordinatorStartupOptions;
  additionalToolProviders?: AdditionalToolProviderFactory;
}

type CredentialBinding = { reference: CredentialReference; resolver: CredentialResolverPort };

function createSessionInputModelPort(model: RuntimeModelSpec, credential: CredentialBinding, timeoutMs: number): SessionInputModelPort {
  return { request: async ({ prompt }) => {
    const apiKey = await credential.resolver.resolve(credential.reference);
    if (!apiKey) throw new Error(`Missing configured credential: ${credential.reference}`);
    const controller = new AbortController();
    const usage: OpenAiUsage[] = [];
    const headerTimer = setTimeout(() => controller.abort(new OpenAiResponseHeaderTimeoutError(timeoutMs)), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model.id,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_completion_tokens: model.maxTokens,
          response_format: { type: "json_object" },
          stream: true,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(headerTimer);
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM router API ${response.status}: ${body.slice(0, 300)}`);
    }
    const output = await readOpenAiChatContent(response, {
      idleTimeoutMs: timeoutMs,
      controller,
      onUsage: (observed) => usage.push(observed),
    });
    if (!output) throw new Error("LLM router returned no JSON content");
    return {
      value: JSON.parse(output),
      usage: usage.map((observed) => ({ model: model.id, ...observed })),
    };
  } };
}

export function composeExecutionApplication(options: ExecutionCompositionOptions): CoreApplicationCoordinator {
  const runtimeFactory = options.runtimeFactory ?? createInProcessRuntime;
  const runtimeDefaults = options.runtimeDefaults ?? {};
  if (runtimeDefaults.routerModel && runtimeDefaults.routerModel.api !== "openai-completions") {
    throw new Error("Router supports only openai-completions; configure TAGENT_ROUTER_API=openai-completions and an explicit TAGENT_ROUTER_API_BASE");
  }
  if (runtimeDefaults.supervisorModel && runtimeDefaults.supervisorModel.api !== "openai-completions") {
    throw new Error("Supervisor supports only openai-completions; configure TAGENT_SUPERVISOR_API=openai-completions and an explicit TAGENT_SUPERVISOR_API_BASE");
  }
  const reviewer = runtimeDefaults.supervisorReviewer ?? (runtimeDefaults.model && runtimeDefaults.credential
    ? new OpenAiSupervisorReviewer({
        model: runtimeDefaults.supervisorModel ?? runtimeDefaults.model as RuntimeModelSpec,
        fallbackModel: runtimeDefaults.supervisorModel ? runtimeDefaults.model as RuntimeModelSpec : undefined,
        credential: runtimeDefaults.credential,
        timeoutMs: runtimeDefaults.supervisorTimeoutMs ?? runtimeDefaults.providerTimeoutMs,
        onUsage: (runId, model, usage) => options.persistence.taskRuns.recordModelUsage(runId, "supervisor", model, usage),
      })
    : process.env.VITEST ? new TestSupervisorReviewer() : undefined);
  if (!reviewer) throw new Error("LLM Supervisor reviewer requires a configured model and API key");
  const supervisor = new TaskRunSupervisor(options.persistence.supervisor, reviewer);
  const supervisorPort: SupervisorPort = {
    reviewCheckpoint: (...args) => supervisor.reviewCheckpoint(...args),
    reviewSettled: (...args) => supervisor.reviewSettled(...args),
    reviewAttemptFailure: (...args) => supervisor.reviewAttemptFailure(...args),
    recordReviewFailure: (...args) => supervisor.recordReviewFailure(...args),
    markExecuted: (...args) => supervisor.markExecuted(...args),
    isReviewError: (error) => error instanceof SupervisorReviewError,
  };
  const routerModel = runtimeDefaults.routerModel
    ?? runtimeDefaults.model as RuntimeModelSpec | undefined;
  const routerTimeoutMs = runtimeDefaults.routerTimeoutMs ?? 5_000;
  const sessionRouter = new SessionInputRouter({
    model: routerModel && runtimeDefaults.credential
      ? createSessionInputModelPort(routerModel, runtimeDefaults.credential, routerTimeoutMs)
      : undefined,
  });
  const projectContextSource = createProjectContextSource(options.workspace, options.projectRuleFiles);
  const artifactSink = createWorkspaceArtifactSink(options.workspace, options.toolArtifactMaxBytes);
  const workspaceEdit = createWorkspaceEditPort(options.workspace);
  const state = new ExecutionState({
    persistence: options.persistence,
    workspace: options.workspace,
    runtimeFactory,
    runtimeDefaults,
  });

  const attemptLauncherRef = createOneShotPort<AttemptLauncherPort>("AttemptLauncherPort");
  const settlementRef = createOneShotPort<AttemptSettlementPort>("AttemptSettlementPort");
  const continuationRef = createOneShotPort<ContinuationControlPort>("ContinuationControlPort");
  const recoveryRef = createOneShotPort<RecoveryControlPort>("RecoveryControlPort");
  const contextRef = createOneShotPort<RunContextPort>("RunContextPort");
  const admissionRef = createOneShotPort<AdmissionDispatchPort>("AdmissionDispatchPort");

  const eventHub = new RunEventHub(state);
  const collaborators = createExecutionCollaborationAdapters({
    persistence: options.persistence,
    memory: options.memory,
    memoryScopeId: options.memoryScopeId ?? "default",
    publish: (runId, type, data) => eventHub.publish(options.persistence.events.appendEvent(runId, type, data)),
  });
  const runtimeRegistry = new RuntimeRegistry(state, { eventHub });
  const controlInbox = new ControlInboxDispatcher(state, { eventHub });
  const recovery = new RecoveryCoordinator(state, {
    continuation: continuationRef.port,
    eventHub,
  });
  recoveryRef.bind(recovery);
  const settlement = new AttemptSettlementService(state, {
    eventHub,
    recovery: recoveryRef.port,
    supervisor: supervisorPort,
  });
  settlementRef.bind(settlement);
  const contextService = new RunContextService(state, {
    attemptExecutor: attemptLauncherRef.port,
    contextEnrichment: collaborators.contextEnrichment,
    continuation: continuationRef.port,
    eventHub,
    recovery: recoveryRef.port,
    runtimeRegistry,
    projectContextSource,
  });
  contextRef.bind(contextService);
  const attemptExecutor = new AttemptExecutor(state, {
    contextService: contextRef.port,
    continuation: continuationRef.port,
    controlInbox,
    eventHub,
    postAttempt: {
      attemptLaunchFailed: ({ inboxItemId, runId, message }) => {
        options.persistence.submissions.recordSessionInboxLaunchFailure(inboxItemId, runId, message);
      },
      attemptFinalized: (run, context) => {
        const current = options.persistence.taskRuns.getRun(run.id);
        if (current) options.persistence.workspaceGoals.recordRunOutcome(current.id);
        if (!context.shuttingDown) admissionRef.port.dispatchSessionInbox(run.sessionId);
      },
      continuationStarted: (runId) => {
        const continued = options.persistence.taskRuns.getRun(runId);
        if (continued?.status === "running") options.persistence.workspaceGoals.recordRunOutcome(continued.id);
      },
    },
    requestEnvelopes: options.persistence.requestEnvelopes,
    recovery: recoveryRef.port,
    runtimeHost: {
      create: (input) => {
        const run = options.persistence.taskRuns.getRun(input.token.runId);
        return createRuntimeHost({
          persistence: options.persistence,
          workspace: state.workspace,
          memory: options.memory,
          memoryScopeId: options.memoryScopeId ?? "default",
          artifactSink,
          workspaceEdit,
          additionalToolProviders: options.additionalToolProviders,
          requestExternalActionApproval: (toolCallId, toolName) => admissionRef.port.requestExternalActionApproval({
            runId: input.token.runId,
            attemptId: input.token.attemptId,
            attempt: input.token.ordinal,
            expectedVersion: input.token.expectedVersion,
            toolCallId,
            toolName,
          }),
          ...input,
          memorySubjectId: run
            ? resolveMemorySubjectId(options.persistence, run.sessionId)
            : input.memorySubjectId,
        });
      },
    },
    runtimeRegistry,
    settlement: settlementRef.port,
    supervisor: supervisorPort,
  });
  attemptLauncherRef.bind(attemptExecutor);
  const continuation = new ContinuationScheduler(state, {
    attemptExecutor: attemptLauncherRef.port,
    contextService: contextRef.port,
    eventHub,
    recovery: recoveryRef.port,
    runtimeRegistry,
    settlement: settlementRef.port,
    userMessageObserver: collaborators.userMessageObserver,
  });
  continuationRef.bind(continuation);
  const admission = new AdmissionCoordinator({
    get closing() { return state.closing; },
    persistence: options.persistence,
    recalledMemory: state.recalledMemory,
    preparationTasks: state.preparationTasks,
    runtimes: state.runtimes,
  }, {
    attemptExecutor: attemptLauncherRef.port,
    router: sessionRouter,
    contextService: contextRef.port,
    continuation: continuationRef.port,
    controlInbox,
    eventHub,
    settlement: settlementRef.port,
    supervisor,
  });
  admissionRef.bind(admission);
  const roadmapGenerator = runtimeDefaults.workspaceGoalRoadmapGenerator
    ?? (routerModel && runtimeDefaults.credential ? new OpenAiWorkspaceGoalRoadmapGenerator({ model: routerModel, credential: runtimeDefaults.credential, timeoutMs: routerTimeoutMs }) : undefined);
  const workspaceGoals = new CoreWorkspaceGoalApplication(options.persistence.workspaceGoals, admission, roadmapGenerator, options.persistence.sessions, options.persistence.workspaceGoalOperations);
  const skills = new CoreSkillApplication(options.persistence.skills, options.persistence.sessions, options.workspace);
  const lifecycle = new ExecutionLifecycleService(state, collaborators.backgroundWork);

  for (const port of [attemptLauncherRef, settlementRef, continuationRef, recoveryRef, contextRef, admissionRef]) {
    port.assertBound();
  }
  const execution = new ExecutionCoordinator(Object.freeze({
    attemptExecutor,
    settlement,
    continuation,
    controlInbox,
    lifecycle,
    recovery,
    contextService,
    eventHub,
    runtimeRegistry,
  }));
  const coordinator = createCoreApplicationCoordinator(Object.freeze({
    admission,
    execution,
    workspaceGoals,
    skills,
  }));
  if ((options.startupOptions?.startupMode ?? "automatic") === "automatic") {
    coordinator.initialize();
    coordinator.startBackgroundWork();
  }
  return coordinator;
}
