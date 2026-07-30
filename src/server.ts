import { mkdir } from "node:fs/promises";
import { Store } from "./store/store.js";
import { AgentService } from "./core/agent-service.js";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3100);
const workspace = process.env.TAGENT_WORKSPACE ?? process.cwd();
const dbFile = process.env.TAGENT_DB ?? "./data/tagent.db";

await mkdir(workspace, { recursive: true });
await mkdir("./data", { recursive: true });
const store = new Store(dbFile);
const service = new AgentService(store, workspace);
const app = createApp({ store, service });
await app.listen({ host: "0.0.0.0", port });
console.log(`TAgent Core listening on http://localhost:${port}`);
