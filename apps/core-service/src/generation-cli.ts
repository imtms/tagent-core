import process from "node:process";
import { loadConfig } from "./config.js";
import { GenerationHostBridge } from "./composition/generation-host-bridge.js";
import { ManagedGenerationAdapter } from "./composition/managed-generation-adapter.js";
import { bootstrapCore, type BootstrappedCore } from "./server.js";

export async function runCoreServiceFromCli(): Promise<BootstrappedCore> {
  const bridge = new GenerationHostBridge();
  const core = await bootstrapCore(loadConfig(), {
    generationManagementFactory: (persistence) => new ManagedGenerationAdapter({
      persistence,
      bridge,
      terminate: () => process.exit(0),
    }),
  });
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
      process.exit(1);
    }
    // The managed IPC channel is itself a live event-loop resource. Once the
    // Generation has released application authority, exit explicitly so a
    // normal Host shutdown never degrades into its force-kill fallback.
    process.exit(0);
  };
  process.once("SIGTERM", () => void closeServer("SIGTERM"));
  process.once("SIGINT", () => void closeServer("SIGINT"));
  return core;
}
