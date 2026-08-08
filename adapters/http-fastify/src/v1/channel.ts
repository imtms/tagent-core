import type { FastifyInstance } from "fastify";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { registerEventV1Routes } from "./event-routes.js";
import { registerSubmissionV1Routes } from "./submission-routes.js";
import { registerTaskRunV1Routes } from "./task-run-routes.js";
import { registerConsoleSessionV1Routes } from "./console-session-routes.js";
import { registerConsoleRunV1Routes } from "./console-run-routes.js";
import { registerConsoleGoalV1Routes } from "./console-goal-routes.js";
import { registerCapabilityV1Routes } from "./capability-routes.js";

export type { ChannelV1Dependencies } from "./dependencies.js";

export async function registerChannelV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): Promise<void> {
  registerCapabilityV1Routes(app, dependencies);
  registerSubmissionV1Routes(app, dependencies);
  registerTaskRunV1Routes(app, dependencies);
  registerEventV1Routes(app, dependencies);
  registerConsoleSessionV1Routes(app, dependencies);
  registerConsoleRunV1Routes(app, dependencies);
  registerConsoleGoalV1Routes(app, dependencies);
}
