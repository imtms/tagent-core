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
import { assembleHttpMemory } from "./composition/http-memory-adapter.js";
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
import {
  createEnvironmentCredentialResolver,
  type GenerationMaintenanceRepository,
} from "@tagent/execution/ports";
import type { AdditionalToolProviderFactory } from "./composition/runtime-host-adapter.js";

type HttpServer = ReturnType<typeof createApp>;

export interface BootstrappedCore {
  app: HttpServer;
  config: AppConfig;
  lifecycle: CoreLifecycle;
  close(): Promise<void>;
}

export interface CoreBackgroundWorkerStarter {
  startMemory(runtime: MemoryRuntime): void | Promise<void>;
}

export interface CoreBootstrapDependencies {
  backgroundWorkerStarter?: CoreBackgroundWorkerStarter;
  generationManagementFactory?: (
    persistence: GenerationMaintenanceRepository,
  ) => CoreGenerationManagement;
}

export interface CoreGenerationManagement {
  readonly defersInitialRecovery: boolean;
  toolProviderFactory(): AdditionalToolProviderFactory;
  bindRecovery(recover: () => void): void;
  prepareHandoffBeforeWriterRelease(): void;
  announceReady(closeGeneration: () => Promise<void>, writerFence: number): void;
  hostStatus(): Readonly<Record<string, unknown>> | null;
}

const defaultBackgroundWorkerStarter: CoreBackgroundWorkerStarter = Object.freeze({
  startMemory: (runtime: MemoryRuntime) => runtime.start(),
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
    workspaceGoals: persistence.workspaceGoals,
    workspaceGoalOperations: persistence.workspaceGoalOperations,
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
  let service: CoreApplicationCoordinator | undefined;
  let managedGeneration: CoreGenerationManagement | undefined;
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
    managedGeneration = dependencies.generationManagementFactory?.(persistence.generationMaintenance);

    lifecycle = new CoreLifecycle({
      instanceLock,
      writerLease: writerConnection.writerLease,
      writerGuard: writerConnection.writerGuard,
      stopBackground: async () => {
        const failures: unknown[] = [];
        try {
          await memoryRuntime?.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length) throw new AggregateError(failures, "Background worker shutdown failed");
      },
      closeRuntimes: async () => { await service?.closeRuntimes(); },
      prepareHandoff: () => managedGeneration?.prepareHandoffBeforeWriterRelease(),
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
      }, persistence.memory);
    }

    service = createCoreApplication({
      persistence: corePersistence,
      workspace: config.workspace,
      runtimeFactory: resolveRuntimeFactory(config.runtime),
      runtimeDefaults: {
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
      memory: memoryRuntime?.service,
      memoryScopeId: config.memory.enabled ? config.memory.workspaceScopeId : "default",
      startupOptions: { startupMode: "deferred" },
      projectRuleFiles: config.projectRuleFiles,
      toolArtifactMaxBytes: config.toolArtifactMaxBytes,
      additionalToolProviders: managedGeneration?.toolProviderFactory(),
    });
    managedGeneration?.bindRecovery(() => {
      service?.recoverContinuations();
      service?.recoverSessionInbox();
    });
    const generationManagement = managedGeneration;
    app = createApp({
      persistence: httpPersistence,
      service,
      workspaceRoot: config.workspace,
      runtimeConfig: publicRuntimeConfig(config, store.getSchemaVersion()),
      serviceCredentials: config.serviceCredentials,
      memory: memoryRuntime?.service ? assembleHttpMemory(memoryRuntime.service) : undefined,
      artifacts: httpArtifactContent,
      writerReadiness: lifecycle,
      generationStatus: generationManagement ? () => generationManagement.hostStatus() : undefined,
      onClose: () => lifecycle!.close(),
    });

    service.initialize();
    if (!managedGeneration?.defersInitialRecovery) {
      service.recoverContinuations();
      service.recoverSessionInbox();
    }

    await app.listen({ host: config.host, port: config.port });
    service.startBackgroundWork();
    if (memoryRuntime) await backgroundWorkerStarter.startMemory(memoryRuntime);
    lifecycle.markReady();
    managedGeneration?.announceReady(
      () => app!.close(),
      writerConnection.writerLease.authority.fence,
    );
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
