import type { FastifyInstance } from "fastify";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { registerEventV1Routes } from "./event-routes.js";
import { registerSubmissionV1Routes } from "./submission-routes.js";
import { registerTaskRunV1Routes } from "./task-run-routes.js";
import { registerConsoleSessionV1Routes } from "./console-session-routes.js";
import { registerConsoleRunV1Routes } from "./console-run-routes.js";
import { registerConsoleGoalV1Routes } from "./console-goal-routes.js";
import { registerCapabilityV1Routes } from "./capability-routes.js";
import { registerCapabilityProfileV1Routes } from "./capability-profile-routes.js";
import { registerOperatorReadV1Routes } from "./operator-read-routes.js";
import { registerOperatorSessionSettingsV1Routes } from "./operator-session-settings-routes.js";
import { registerOperatorInboxV1Routes } from "./operator-inbox-routes.js";
import { registerOperatorContextManifestV1Routes } from "./operator-context-manifest-routes.js";
import { registerOperatorSkillV1Routes } from "./operator-skill-routes.js";

export type { ChannelV1Dependencies } from "./dependencies.js";

export async function registerChannelV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): Promise<void> {
  registerCapabilityV1Routes(app, dependencies);
  registerCapabilityProfileV1Routes(app, dependencies);
  registerOperatorReadV1Routes(app, dependencies);
  registerOperatorSessionSettingsV1Routes(app, dependencies);
  registerOperatorInboxV1Routes(app, dependencies);
  registerOperatorContextManifestV1Routes(app, dependencies);
  registerOperatorSkillV1Routes(app, dependencies);
  registerSubmissionV1Routes(app, dependencies);
  registerTaskRunV1Routes(app, dependencies);
  registerEventV1Routes(app, dependencies);
  registerConsoleSessionV1Routes(app, dependencies);
  registerConsoleRunV1Routes(app, dependencies);
  registerConsoleGoalV1Routes(app, dependencies);
}
