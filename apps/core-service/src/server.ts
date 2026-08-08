import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createApp } from "@tagent/http-fastify";
import type { HttpPersistencePort } from "@tagent/http-fastify/ports";
import { createModel, loadConfig, publicRuntimeConfig, type AppConfig } from "./config.js";
import { httpArtifactContent } from "./composition/artifact-content.js";
import { AgentService } from "./application/agent-service.js";
import type { CoreApplicationPort } from "./application/agent-service-factory.js";
import { CoreHeartbeatDeadlineError, CoreLifecycle } from "./composition/core-lifecycle.js";
import type { AgentServicePersistencePort } from "./application/ports/index.js";
import { LearningProjectionRuntime } from "./composition/learning-projection-runtime.js";
import { CanaryGovernanceRuntime } from "./composition/canary-governance-runtime.js";
import { LearningBackgroundRuntimeCoordinator } from "./composition/learning-background-runtime-coordinator.js";
import { OpenAiSemanticJudgeModelAdapter } from "./composition/semantic-judge-model-adapter.js";
import { assembleHttpMemory } from "./composition/http-memory-adapter.js";
import {
  DistillationWorker,
  LearningFeatureControl,
  LearningWorkflowRevisionMaterializer,
  SemanticJudge,
  WorkflowService,
} from "@tagent/learning";
import {
  ActiveLearningProjectionWorker,
  LearningProjectionAuthorityCoordinator,
  ShadowLearningProjectionWorker,
  WorkflowServiceActiveProjectionApplier,
} from "@tagent/learning/application";
import {
  CanaryGovernanceWorker,
  WorkflowGovernanceApplication,
} from "@tagent/governance/application";
import {
  selectGovernanceApprovalAuthority,
  type GovernanceApprovalAuthoritySwitchEvidence,
} from "@tagent/governance/domain";
import type { MemoryRuntime } from "@tagent/memory/composition";
import {
  Store,
  acquireCoreInstanceLock,
  createGuardedLegacyStoreAdapter,
  claimCoreWriterConnectionWithRetry,
  type CoreInstanceLock,
  type CoreWriterConnection,
  type LegacyStoreAdapter,
} from "@tagent/persistence-sqlite";
import { resolveRuntimeFactory } from "@tagent/runtime-pi/factory";

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

const CURRENT_RELEASE_GOVERNANCE_APPROVAL_AUTHORITY_EVIDENCE = Object.freeze({
  unresolved: {
    complete: true,
    summary: {
      total: 0,
      active: 0,
      bySource: { legacy_run: 0, legacy_workflow: 0 },
      activeBySource: { legacy_run: 0, legacy_workflow: 0 },
      byReason: {},
    },
  },
  comparisons: {
    complete: true,
    coverage: { expected: 1, compared: 1 },
    summary: {
      total: 1,
      match: 1,
      mismatch: 0,
      unresolved: 0,
      activeUnresolved: 0,
      missing: 0,
    },
  },
  handlers: {
    request: { ready: false, evidence: ["current release canonical request handler is dormant"] },
    decide: { ready: false, evidence: ["current release canonical decide handler is dormant"] },
    consume: { ready: false, evidence: ["current release canonical consume handler is dormant"] },
    execute: { ready: false, evidence: ["current release canonical execute handler is dormant"] },
  },
  noBypass: {
    approved: false,
    activeBypassCount: 0,
    evidence: ["current release production no-bypass assessment is not approved"],
  },
} satisfies GovernanceApprovalAuthoritySwitchEvidence);

function assembleAgentServicePersistence(
  persistence: LegacyStoreAdapter,
): AgentServicePersistencePort {
  return Object.freeze({
    attempts: persistence.attempts,
    attemptAuthority: persistence.attemptAuthority,
    runtimeMutations: persistence.runtimeMutations,
    sessions: persistence.sessions,
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
    supervisorDecisions: persistence.supervisorDecisions,
    runtime: persistence.runtime,
    supervisor: persistence.supervisor,
    workflowGovernance: persistence.workflowGovernance,
    learning: persistence.learning,
    workflow: persistence.workflow,
    workspaceGoals: persistence.workspaceGoals,
  });
}

function assembleHttpPersistence(persistence: LegacyStoreAdapter): HttpPersistencePort {
  return Object.freeze({
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
  selectGovernanceApprovalAuthority({
    requestedAuthority: config.governanceApprovalAuthority,
    ...CURRENT_RELEASE_GOVERNANCE_APPROVAL_AUTHORITY_EVIDENCE,
  });
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
  let service: CoreApplicationPort | undefined;
  let unsubscribeLearning: (() => void) | undefined;
  const backgroundWorkerStarter = dependencies.backgroundWorkerStarter ?? defaultBackgroundWorkerStarter;

  try {
    instanceLock = await acquireCoreInstanceLock(config.database);
    store = new Store(config.database, {
      deferPostMigrationRecovery: true,
      defaultModelId: config.model.modelId,
    });
    writerConnection = await claimCoreWriterConnectionWithRetry(store, {
      ownerId: instanceLock.metadata.instanceId,
      pid: instanceLock.metadata.pid,
      host: instanceLock.metadata.host,
    });
    writerConnection.writerGuard.installConnectionGuard();
    const persistence = createGuardedLegacyStoreAdapter(store, writerConnection.writerGuard);
    const agentPersistence = assembleAgentServicePersistence(persistence);
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
    store.runPostMigrationRecovery(writerConnection.writerGuard);

    const learningControl = new LearningFeatureControl(persistence.settings, config.memory.enabled, {
      learningEnabled: config.learning.enabledByDefault,
      autoExecutionEnabled: config.learning.autoExecutionEnabledByDefault,
    });
    const semanticJudge = config.learning.semanticJudgeEnabled
      && config.learning.semanticJudgeBaseUrl
      && config.learning.semanticJudgeApiKey
      && config.learning.semanticJudgeModel
      ? new SemanticJudge({
        model: new OpenAiSemanticJudgeModelAdapter({
          baseUrl: config.learning.semanticJudgeBaseUrl,
          apiKey: config.learning.semanticJudgeApiKey,
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
      memoryRuntime = await createMemoryRuntime(config.memory, persistence.memory, semanticJudge);
    }

    service = new AgentService(
      agentPersistence,
      config.workspace,
      resolveRuntimeFactory(config.runtime),
      {
        model: createModel(config.model),
        fallbackModels: config.fallbackModels.map(createModel),
        routerModel: createModel(config.routerModel),
        supervisorModel: createModel(config.supervisorModel),
        apiKey: config.apiKey,
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
    const workflowService = new WorkflowService(
      persistence.workflow,
      undefined,
      learningControl,
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
      new WorkflowServiceActiveProjectionApplier(workflowService),
      {
        owner: `core:${instanceLock.metadata.instanceId}:learning-active-v1`,
        leaseMs: learningProjectionLeaseMs,
      },
    );
    learningProjectionRuntime = new LearningProjectionRuntime(
      {
        shadow: new ShadowLearningProjectionWorker(persistence.learningIntegration, {
          owner: `core:${instanceLock.metadata.instanceId}:learning-shadow-v1`,
          leaseMs: learningProjectionLeaseMs,
        }),
        active: activeLearningProjectionWorker,
        coordinator: new LearningProjectionAuthorityCoordinator(
          persistence.learningIntegration,
          activeLearningProjectionWorker,
        ),
      },
      {
        intervalMs: config.learning.distillationWorkerIntervalMs,
        authorityHeartbeatMs: Math.floor(learningProjectionLeaseMs / 3),
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

export const main = runCoreServiceFromCli;
