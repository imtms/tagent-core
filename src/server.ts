import { mkdir } from "node:fs/promises";
import { Store } from "./store/store.js";
import { AgentService } from "./core/agent-service.js";
import { createApp } from "./app.js";
import { createModel, loadConfig, publicRuntimeConfig } from "./config.js";
import { resolveRuntimeFactory } from "./runtime/factory.js";
import type { MemoryRuntime } from "./memory/factory.js";
import { WorkflowService } from "./learning/workflow-service.js";
import { DistillationWorker } from "./learning/distillation-worker.js";
import { LearningFeatureControl } from "./learning/feature-control.js";
import { SemanticJudge } from "./learning/semantic-judge.js";

const config = loadConfig();
await mkdir(config.workspace, { recursive: true });
await mkdir("./data", { recursive: true });
const store = new Store(config.database);
const learningControl = new LearningFeatureControl(store, config.memory.enabled, { learningEnabled: config.learning.enabledByDefault, autoExecutionEnabled: config.learning.autoExecutionEnabledByDefault });
const semanticJudge=config.learning.semanticJudgeEnabled&&config.learning.semanticJudgeBaseUrl&&config.learning.semanticJudgeApiKey&&config.learning.semanticJudgeModel?new SemanticJudge({baseUrl:config.learning.semanticJudgeBaseUrl,apiKey:config.learning.semanticJudgeApiKey,model:config.learning.semanticJudgeModel,timeoutMs:config.learning.semanticJudgeTimeoutMs,minimumConfidence:config.learning.semanticJudgeMinimumConfidence,cacheTtlMs:config.learning.semanticJudgeCacheTtlMs,maxCallsPerMinute:config.learning.semanticJudgeMaxCallsPerMinute},store):undefined;
let memoryRuntime: MemoryRuntime | null = null;
if (config.memory.enabled) {
  const { createMemoryRuntime } = await import("./memory/factory.js");
  memoryRuntime = await createMemoryRuntime(config.memory, store, semanticJudge);
  memoryRuntime.start();
}
const service = new AgentService(
  store,
  config.workspace,
  resolveRuntimeFactory(config.runtime),
  { model: createModel(config.model), routerModel: createModel(config.routerModel), supervisorModel: createModel(config.supervisorModel), apiKey: config.apiKey, providerTimeoutMs: config.providerTimeoutMs, routerTimeoutMs: config.routerTimeoutMs, supervisorTimeoutMs: config.supervisorTimeoutMs, providerMaxRetries: config.providerMaxRetries, runTimeoutMs: config.runTimeoutMs, runHardTimeoutMs: config.runHardTimeoutMs, maxContinuations: config.maxContinuations, contextWindow: config.model.contextWindow, maxContextTurns: config.maxContextTurns, controlInboxCapacity: config.controlInboxCapacity },
  memoryRuntime?.service,
  config.memory.enabled ? config.memory.workspaceScopeId : "default",
  learningControl,
  semanticJudge,
);
const distillationWorker = new DistillationWorker(new WorkflowService(store, undefined, learningControl, semanticJudge), config.learning.distillationWorkerIntervalMs);
if (learningControl.snapshot().learningEnabled) distillationWorker.start();
learningControl.onChange(async (state) => { if (state.learningEnabled) distillationWorker.start(); else await distillationWorker.stop(); });
const app = createApp({ store, service, workspaceRoot: config.workspace, runtimeConfig: { ...publicRuntimeConfig(config, store.getSchemaVersion()), ...learningControl.snapshot() }, serviceCredentials: config.serviceCredentials, memory: memoryRuntime?.service, distillationWorker, learningControl, closeResources: async () => { await distillationWorker.close(); await (memoryRuntime?.close() ?? Promise.resolve()); } });
service.recoverContinuations();
service.recoverSessionInbox();
await app.listen({ host: "0.0.0.0", port: config.port });
console.log(`TAgent Core listening on http://localhost:${config.port}`);
console.log(`Runtime=${config.runtime} Model=${config.model.modelId} Base=${config.model.baseUrl}`);

let closing = false;
const closeServer = async (signal: NodeJS.Signals) => {
  if (closing) return;
  closing = true;
  console.log(`Received ${signal}; closing TAgent Core`);
  try { await app.close(); }
  catch (error) {
    console.error("TAgent Core close failed", error);
    process.exitCode = 1;
  }
};
process.once("SIGTERM", () => void closeServer("SIGTERM"));
process.once("SIGINT", () => void closeServer("SIGINT"));
