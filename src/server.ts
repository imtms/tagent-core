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
  { model: createModel(config.model), apiKey: config.apiKey, providerTimeoutMs: config.providerTimeoutMs, providerMaxRetries: config.providerMaxRetries, runTimeoutMs: config.runTimeoutMs, maxContinuations: config.maxContinuations, maxRunTokens: config.maxRunTokens },
);
const app = createApp({ store, service, runtimeConfig: publicRuntimeConfig(config) });
await app.listen({ host: "0.0.0.0", port: config.port });
console.log(`TAgent Core listening on http://localhost:${config.port}`);
console.log(`Runtime=${config.runtime} Model=${config.model.modelId} Base=${config.model.baseUrl}`);
