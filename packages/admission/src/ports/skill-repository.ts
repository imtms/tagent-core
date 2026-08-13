import type { CreateSkillRevisionInput, SkillRevision, SkillSummary } from "../domain/skill.js";

/** Storage-neutral Skill catalog and per-Session selection boundary. */
export interface SkillRepository {
  createRevision(input: CreateSkillRevisionInput): SkillRevision;
  listSkills(): SkillSummary[];
  getSkill(skillId: string): SkillRevision | undefined;
  listRevisions(skillId: string): SkillRevision[];
  getRevision(revisionId: string): SkillRevision | undefined;
  listWorkspaceSkills(workspaceId: string): SkillRevision[];
  replaceWorkspaceSkills(workspaceId: string, skillIds: readonly string[]): SkillRevision[] | undefined;
  deleteSkill(skillId: string): SkillRevision[] | undefined;
}
