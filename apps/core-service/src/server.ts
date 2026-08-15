import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createApp } from "@tagent/http-fastify";
import type { HttpPersistencePort } from "@tagent/http-fastify/ports";
import { createModel, loadConfig, publicRuntimeConfig, type AppConfig } from "./config.js";
import { httpArtifactContent } from "./composition/artifact-content.js";
import { createCoreApplication } from "./application/core-application-factory.js";
import type { CoreApplicationCoordinator } from "./application/core-application-coordinator.js";
import { CoreHeartbeatDeadlineError, CoreLifecycle } from "./composition/core-lifecycle.js";
import type { CoreApplicationPersistencePort } from "./application/ports/index.js";
import { LearningProjectionRuntime } from "./composition/learning-projection-runtime.js";
import { CanaryGovernanceRuntime } from "./composition/canary-governance-runtime.js";
import { LearningBackgroundRuntimeCoordinator } from "./composition/learning-background-runtime-coordinator.js";
import { OpenAiSemanticJudgeModelAdapter } from "./composition/semantic-judge-model-adapter.js";
import { assembleHttpMemory } from "./composition/http-memory-adapter.js";
import {
  DistillationWorker,
  LearningFeatureControl,
  LearningService,
  LearningWorkflowRevisionMaterializer,
  SemanticJudge,
  WorkflowLearningService,
} from "@tagent/learning";
import {
  ActiveLearningProjectionWorker,
  LearningServicesProjectionApplier,
} from "@tagent/learning/application";
import {
  CanaryGovernanceWorker,
  WorkflowGovernanceApplication,
} from "@tagent/governance/application";
import type { MemoryRuntime } from "@tagent/memory/composition";
import {
  Store,
  acquireCoreInstanceLock,
  createGuardedSqlitePersistence,
  claimCoreWriterConnectionWithRetry,
  type CoreInstanceLock,
  type CoreWriterConnection,
  type SqlitePersistence,
} from "@tagent/persistence-sqlite";
import { resolveRuntimeFactory } from "@tagent/runtime-pi/factory";
import { createEnvironmentCredentialResolver } from "@tagent/execution/ports";

type HttpServer = ReturnType<typeof createApp>;

export interface BootstrappedCore {
  app: HttpServer;
  config: AppConfig;
  lifecycle: CoreLifecycle;
  close(): Promise<void>;
}

export interface CoreBackgroundWorkerStarter {
  startMemory(runtime: MemoryRuntime): void | Promise<void>;
  startDistillation(worker: DistillationWorker): void | Promise<void>;
  startLearningProjection?(runtime: LearningProjectionRuntime): void | Promise<void>;
}

export interface CoreBootstrapDependencies {
  backgroundWorkerStarter?: CoreBackgroundWorkerStarter;
}

const defaultBackgroundWorkerStarter: CoreBackgroundWorkerStarter = Object.freeze({
  startMemory: (runtime: MemoryRuntime) => runtime.start(),
  startDistillation: (worker: DistillationWorker) => worker.start(),
  startLearningProjection: (runtime: LearningProjectionRuntime) => runtime.start(),
});

function assembleCoreApplicationPersistence(
  persistence: SqlitePersistence,
): CoreApplicationPersistencePort {
  return Object.freeze({
    attempts: persistence.attempts,
    runtimeMutations: persistence.runtimeMutations,
    sessions: persistence.sessions,
    skills: persistence.skills,
    submissions: persistence.submissions,
    taskRuns: persistence.taskRuns,
    taskRunTransitions: persistence.taskRunTransitions,
    continuations: persistence.continuations,
    controlInbox: persistence.controlInbox,
    events: persistence.events,
    transcript: persistence.transcript,
    checkpoints: persistence.checkpoints,
    approvals: persistence.approvals,
    contextManifests: persistence.contextManifests,
    requestEnvelopes: persistence.requestEnvelopes,
    supervisorDecisions: persistence.supervisorDecisions,
    runtime: persistence.runtime,
    supervisor: persistence.supervisor,
    workflowGovernance: persistence.workflowGovernance,
    learning: persistence.learning,
    workflow: persistence.workflow,
    workspaceGoals: persistence.workspaceGoals,
  });
}

function assembleHttpPersistence(persistence: SqlitePersistence): HttpPersistencePort {
  return Object.freeze({
    profileContracts: persistence.profileContracts,
    operatorRead: persistence.operatorRead,
    sessions: persistence.sessions,
    submissions: persistence.submissions,
    taskRuns: persistence.taskRuns,
    taskRunCommands: persistence.taskRunCommands,
    supervisorDecisions: persistence.supervisorDecisions,
    contextManifests: persistence.contextManifests,
    controlInbox: persistence.controlInbox,
    operations: persistence.operations,
    transcript: persistence.transcript,
    evidence: persistence.evidence,
    eventConsumers: persistence.eventConsumers,
    workspaceGoals: persistence.workspaceGoals,
    workspaceGoalOperations: persistence.workspaceGoalOperations,
  });
}

export async function bootstrapCore(
  config: AppConfig = loadConfig(),
  dependencies: CoreBootstrapDependencies = {},
): Promise<BootstrappedCore> {
  await mkdir(config.workspace, { recursive: true });
  await mkdir(path.dirname(path.resolve(config.database)), { recursive: true });

  let instanceLock: CoreInstanceLock | undefined;
  let store: Store | undefined;
  let writerConnection: CoreWriterConnection | undefined;
  let lifecycle: CoreLifecycle | undefined;
  let app: HttpServer | undefined;
  let memoryRuntime: MemoryRuntime | null = null;
  let distillationWorker: DistillationWorker | undefined;
  let learningProjectionRuntime: LearningProjectionRuntime | undefined;
  let canaryGovernanceRuntime: CanaryGovernanceRuntime | undefined;
  let learningBackgroundRuntime: LearningBackgroundRuntimeCoordinator | undefined;
  let canaryBackgroundRuntime: LearningBackgroundRuntimeCoordinator | undefined;
  let service: CoreApplicationCoordinator | undefined;
  let unsubscribeLearning: (() => void) | undefined;
  const backgroundWorkerStarter = dependencies.backgroundWorkerStarter ?? defaultBackgroundWorkerStarter;

  try {
    instanceLock = await acquireCoreInstanceLock(config.database);
    store = new Store(config.database, {
      deferStartupRecovery: true,
      defaultModelId: config.model.modelId,
    });
    writerConnection = await claimCoreWriterConnectionWithRetry(store, {
      ownerId: instanceLock.metadata.instanceId,
      pid: instanceLock.metadata.pid,
      host: instanceLock.metadata.host,
    });
    writerConnection.writerGuard.installConnectionGuard();
    const persistence = createGuardedSqlitePersistence(store, writerConnection.writerGuard);
    const corePersistence = assembleCoreApplicationPersistence(persistence);
    const httpPersistence = assembleHttpPersistence(persistence);

    lifecycle = new CoreLifecycle({
      instanceLock,
      writerLease: writerConnection.writerLease,
      writerGuard: writerConnection.writerGuard,
      stopBackground: async () => {
        unsubscribeLearning?.();
        unsubscribeLearning = undefined;
        const failures: unknown[] = [];
        try {
          await canaryBackgroundRuntime?.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await learningBackgroundRuntime?.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await canaryGovernanceRuntime?.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await learningProjectionRuntime?.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await distillationWorker?.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await memoryRuntime?.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length) throw new AggregateError(failures, "Background worker shutdown failed");
      },
      closeRuntimes: async () => { await service?.closeRuntimes(); },
      closeStore: () => store?.close(),
      requestServerClose: async (failure) => {
        if (app) await app.close();
        else await lifecycle?.close(failure);
      },
      onFailure: (failure) => {
        if (failure instanceof CoreHeartbeatDeadlineError) {
          console.error("TAgent Core writer lifecycle failed", failure, { heartbeat: failure.diagnostics });
        } else {
          console.error("TAgent Core writer lifecycle failed", failure);
        }
        process.exitCode = 1;
      },
    });
    await lifecycle.start();
    store.runStartupRecovery(writerConnection.writerGuard);

    const credentialResolver = createEnvironmentCredentialResolver(process.env);
    const learningControl = new LearningFeatureControl(persistence.settings, config.memory.enabled, {
      learningEnabled: config.learning.enabledByDefault,
      autoExecutionEnabled: config.learning.autoExecutionEnabledByDefault,
    });
    const semanticJudge = config.learning.semanticJudgeEnabled
      && config.learning.semanticJudgeBaseUrl
      && config.learning.semanticJudgeCredentialReference
      && config.learning.semanticJudgeModel
      ? new SemanticJudge({
        model: new OpenAiSemanticJudgeModelAdapter({
          baseUrl: config.learning.semanticJudgeBaseUrl,
          resolveApiKey: async () => credentialResolver.resolve(config.learning.semanticJudgeCredentialReference!),
          modelId: config.learning.semanticJudgeModel,
          timeoutMs: config.learning.semanticJudgeTimeoutMs,
        }),
        maxAttempts: config.providerMaxRetries + 1,
        minimumConfidence: config.learning.semanticJudgeMinimumConfidence,
        cacheTtlMs: config.learning.semanticJudgeCacheTtlMs,
        maxCallsPerMinute: config.learning.semanticJudgeMaxCallsPerMinute,
      }, persistence.semanticCache)
      : undefined;

    if (config.memory.enabled) {
      const { createMemoryRuntime } = await import("@tagent/memory/composition");
      const embeddingCredentialReference = config.memory.embeddingCredentialReference;
      const extractorCredentialReference = config.memory.extractorCredentialReference;
      memoryRuntime = await createMemoryRuntime({
        ...config.memory,
        resolveEmbeddingApiKey: embeddingCredentialReference
          ? async () => credentialResolver.resolve(embeddingCredentialReference)
          : undefined,
        resolveExtractorApiKey: extractorCredentialReference
          ? async () => credentialResolver.resolve(extractorCredentialReference)
          : undefined,
      }, persistence.memory, semanticJudge);
    }

    service = createCoreApplication(
      corePersistence,
      config.workspace,
      resolveRuntimeFactory(config.runtime),
      {
        model: createModel(config.model),
        fallbackModels: config.fallbackModels.map(createModel),
        routerModel: createModel(config.routerModel),
        supervisorModel: createModel(config.supervisorModel),
        credential: { reference: config.apiCredentialReference, resolver: credentialResolver },
        providerTimeoutMs: config.providerTimeoutMs,
        routerTimeoutMs: config.routerTimeoutMs,
        supervisorTimeoutMs: config.supervisorTimeoutMs,
        providerMaxRetries: config.providerMaxRetries,
        runTimeoutMs: config.runTimeoutMs,
        runHardTimeoutMs: config.runHardTimeoutMs,
        maxContinuations: config.maxContinuations,
        contextWindow: config.model.contextWindow,
        maxContextTurns: config.maxContextTurns,
        historicalToolResultChars: config.historicalToolResultChars,
        historicalTaskRunReceiptChars: config.historicalTaskRunReceiptChars,
        controlInboxCapacity: config.controlInboxCapacity,
      },
      memoryRuntime?.service,
      config.memory.enabled ? config.memory.workspaceScopeId : "default",
      learningControl,
      semanticJudge,
      { startupMode: "deferred" },
      config.projectRuleFiles,
      config.toolArtifactMaxBytes,
    );
    const workflowService = new WorkflowLearningService(
      persistence.workflow,
      undefined,
      learningControl,
      semanticJudge,
    );
    const projectionLearningService = new LearningService(
      persistence.learning,
      memoryRuntime?.service,
      config.memory.enabled ? config.memory.workspaceScopeId : "default",
      semanticJudge,
    );
    distillationWorker = new DistillationWorker(workflowService, config.learning.distillationWorkerIntervalMs);
    canaryGovernanceRuntime = new CanaryGovernanceRuntime(
      new CanaryGovernanceWorker(
        persistence.workflowGovernance,
        new WorkflowGovernanceApplication(
          persistence.workflowGovernance,
          new LearningWorkflowRevisionMaterializer(),
        ),
      ),
      {
        intervalMs: config.learning.distillationWorkerIntervalMs,
        onError: (error) => console.error("Canary Governance background tick failed", error),
      },
    );
    const learningProjectionLeaseMs = Math.min(
      Math.max(config.learning.distillationWorkerIntervalMs * 3, 30_000),
      300_000,
    );
    const activeLearningProjectionWorker = new ActiveLearningProjectionWorker(
      persistence.learningIntegration,
      new LearningServicesProjectionApplier(projectionLearningService, workflowService),
      {
        owner: `core:${instanceLock.metadata.instanceId}:learning-projection-v1`,
        leaseMs: learningProjectionLeaseMs,
      },
    );
    learningProjectionRuntime = new LearningProjectionRuntime(
      activeLearningProjectionWorker,
      {
        intervalMs: config.learning.distillationWorkerIntervalMs,
        afterApplied: async () => {
          await workflowService.drainSemanticLearningJobs();
          await projectionLearningService.drainSemanticLearningJobs();
          await projectionLearningService.drainFeedbackAttribution();
        },
      },
    );
    const startLearningProjection = () => backgroundWorkerStarter.startLearningProjection
      ? backgroundWorkerStarter.startLearningProjection(learningProjectionRuntime!)
      : defaultBackgroundWorkerStarter.startLearningProjection!(learningProjectionRuntime!);
    learningBackgroundRuntime = new LearningBackgroundRuntimeCoordinator(
      [
        { name: "learning-projection", start: startLearningProjection, stop: () => learningProjectionRuntime!.stop() },
        { name: "distillation", start: () => backgroundWorkerStarter.startDistillation(distillationWorker!), stop: () => distillationWorker!.stop() },
      ],
      [
        { name: "learning-projection", start: startLearningProjection, stop: () => learningProjectionRuntime!.stop() },
        { name: "distillation", start: () => backgroundWorkerStarter.startDistillation(distillationWorker!), stop: () => distillationWorker!.stop() },
      ],
    );
    const canaryUnit = {
      name: "canary-governance",
      start: () => canaryGovernanceRuntime!.start(),
      stop: () => canaryGovernanceRuntime!.stop(),
    };
    canaryBackgroundRuntime = new LearningBackgroundRuntimeCoordinator([canaryUnit], [canaryUnit]);
    unsubscribeLearning = learningControl.onChange((state) => Promise.all([
      learningBackgroundRuntime!.reconcile(state.learningEnabled),
      canaryBackgroundRuntime!.reconcile(state.autoExecutionEnabled),
    ]).then(() => undefined));

    app = createApp({
      persistence: httpPersistence,
      service,
      workspaceRoot: config.workspace,
      runtimeConfig: { ...publicRuntimeConfig(config, store.getSchemaVersion()), ...learningControl.snapshot() },
      serviceCredentials: config.serviceCredentials,
      memory: memoryRuntime?.service ? assembleHttpMemory(memoryRuntime.service) : undefined,
      artifacts: httpArtifactContent,
      distillationWorker,
      learningControl,
      writerReadiness: lifecycle,
      onClose: () => lifecycle!.close(),
    });

    service.initialize();
    service.recoverContinuations();
    service.recoverSessionInbox();

    await app.listen({ host: config.host, port: config.port });
    service.startBackgroundWork();
    if (memoryRuntime) await backgroundWorkerStarter.startMemory(memoryRuntime);
    const initialLearningState = learningControl.snapshot();
    await Promise.all([
      learningBackgroundRuntime.reconcile(initialLearningState.learningEnabled),
      canaryBackgroundRuntime.reconcile(initialLearningState.autoExecutionEnabled),
    ]);
    lifecycle.markReady();
    return { app, config, lifecycle, close: () => app!.close() };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    const attempt = async (operation: () => void | Promise<void>) => {
      try {
        await operation();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    };
    if (app) await attempt(() => app!.close());
    else if (lifecycle) await attempt(() => lifecycle!.close());
    else {
      if (writerConnection) {
        await attempt(() => writerConnection!.writerGuard.removeConnectionGuard());
        await attempt(() => { writerConnection!.writerLease.release(); });
      }
      if (store) await attempt(() => store!.close());
      if (instanceLock) await attempt(() => instanceLock!.release());
    }
    if (cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, "TAgent Core bootstrap and cleanup failed", { cause: error });
    }
    throw error;
  }
}

export async function runCoreServiceFromCli(): Promise<BootstrappedCore> {
  const core = await bootstrapCore();
  console.log(`TAgent Core listening on http://${core.config.host}:${core.config.port}`);
  console.log(`Runtime=${core.config.runtime} Model=${core.config.model.modelId} Base=${core.config.model.baseUrl}`);

  let closing = false;
  const closeServer = async (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    console.log(`Received ${signal}; closing TAgent Core`);
    try {
      await core.close();
    } catch (error) {
      console.error("TAgent Core close failed", error);
      process.exitCode = 1;
    }
  };
  process.once("SIGTERM", () => void closeServer("SIGTERM"));
  process.once("SIGINT", () => void closeServer("SIGINT"));
  return core;
}
