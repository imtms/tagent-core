import { mkdir } from "node:fs/promises";
import { Store } from "./store/store.js";
import { AgentService } from "./core/agent-service.js";
import { createApp } from "./app.js";
import { createModel, loadConfig, publicRuntimeConfig } from "./config.js";
import { resolveRuntimeFactory } from "./runtime/factory.js";

const config = loadConfig();
await mkdir(config.workspace, { recursive: true });
await mkdir("./data", { recursive: true });
const store = new Store(config.database);
const service = new AgentService(
  store,
  config.workspace,
  resolveRuntimeFactory(config.runtime),
  { model: createModel(config.model), apiKey: config.apiKey, providerTimeoutMs: config.providerTimeoutMs, providerMaxRetries: config.providerMaxRetries, runTimeoutMs: config.runTimeoutMs, runHardTimeoutMs: config.runHardTimeoutMs, maxContinuations: config.maxContinuations, maxRunTokens: config.maxRunTokens, contextWindow: config.model.contextWindow, maxContextTurns: config.maxContextTurns, contextReserveTokens: config.contextReserveTokens, dynamicBudget: config.dynamicBudget, controlInboxCapacity: config.controlInboxCapacity },
);
const app = createApp({ store, service, runtimeConfig: publicRuntimeConfig(config, store.getSchemaVersion()) });
service.recoverContinuations();
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
