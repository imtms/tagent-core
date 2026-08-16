import type { CoreApplicationServices } from "./core-application-services.js";

const PUBLIC_METHODS = {
  admission: [
    "recoverSessionInbox", "approveRunApproval", "enqueueSessionInput", "updateSessionInputProfile",
    "reorderSessionInputsProfile", "deleteSessionInputProfile", "decideSessionInputProfile",
    "mergeSessionInputsProfile", "startSessionInputNow", "requestParallelSessionInputApproval",
    "retryInboxLaunch", "start",
  ],
  execution: [
    "initialize", "startBackgroundWork", "closeRuntimes", "recoverContinuations", "enqueueControl",
    "followUp", "steer", "compact", "cancel", "resume", "rejectRunApproval", "submitUserInput",
    "subscribe", "replay", "getRun", "getCurrentAttemptId",
  ],
  workspaceGoals: ["generateWorkspaceGoalRoadmap", "startWorkspaceGoalRoadmapItem"],
  skills: [
    "listSkills", "listSkillsProfile", "getSkill", "getSkillProfile", "listSkillRevisions",
    "listSkillRevisionsProfile", "uploadSkill", "uploadSkillProfile", "updateSkill",
    "updateSkillProfile", "deleteSkill", "deleteSkillProfile", "listWorkspaceSkills",
    "listWorkspaceSkillsProfile", "replaceWorkspaceSkills", "replaceWorkspaceSkillsProfile",
  ],
} as const satisfies {
  [Group in keyof CoreApplicationServices]: readonly (keyof CoreApplicationServices[Group])[];
};

type SelectedMethods<Group extends keyof CoreApplicationServices> = Pick<
  CoreApplicationServices[Group],
  Extract<(typeof PUBLIC_METHODS)[Group][number], keyof CoreApplicationServices[Group]>
>;

export type CoreApplicationCoordinator =
  & SelectedMethods<"admission">
  & SelectedMethods<"execution">
  & SelectedMethods<"workspaceGoals">
  & SelectedMethods<"skills">;

/**
 * Exposes the intentionally flat application ABI without maintaining a forwarding God class.
 * Binding is explicit, collision-checked, and performed once at composition time.
 */
export function createCoreApplicationCoordinator(
  services: CoreApplicationServices,
): CoreApplicationCoordinator {
  const coordinator: Record<string, (...args: never[]) => unknown> = {};
  for (const [group, methods] of Object.entries(PUBLIC_METHODS) as Array<
    [keyof CoreApplicationServices, readonly string[]]
  >) {
    const service = services[group] as unknown as Record<string, (...args: never[]) => unknown>;
    for (const method of methods) {
      if (coordinator[method]) throw new Error(`Duplicate Core application method ${method}`);
      const implementation = service[method];
      if (typeof implementation !== "function") {
        throw new Error(`Core application service ${String(group)} is missing method ${method}`);
      }
      coordinator[method] = implementation.bind(service);
    }
  }
  return Object.preventExtensions(coordinator) as unknown as CoreApplicationCoordinator;
}
