import type { TaskRun } from "../domain/task-run.js";
import type { AttemptRuntimePort, RuntimeSkill } from "../ports/attempt-runtime.js";

export function runtimeSkillFor(run: TaskRun): RuntimeSkill | undefined {
  const skill = run.contract?.skill;
  return skill ? {
    name: skill.name, description: skill.description, content: skill.content,
    filePath: skill.filePath, sha256: skill.sha256,
    disableModelInvocation: skill.disableModelInvocation,
  } : undefined;
}

export async function executeRuntimePrompt(runtime: AttemptRuntimePort, prompt: string, skillName?: string): Promise<void> {
  if (!skillName) return runtime.prompt(prompt);
  if (!runtime.invokeSkill) throw new Error(`Runtime does not support selected Skill ${skillName}`);
  return runtime.invokeSkill(skillName, prompt);
}
