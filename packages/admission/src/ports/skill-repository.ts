import type { CreateSkillRevisionInput, SkillRevision, SkillSummary } from "../domain/skill.js";

/** Storage-neutral Skill catalog and per-Session selection boundary. */
export interface SkillRepository {
  createRevision(input: CreateSkillRevisionInput): SkillRevision;
  listSkills(): SkillSummary[];
  getRevision(revisionId: string): SkillRevision | undefined;
  getSessionSkill(sessionId: string): SkillRevision | undefined;
  bindSessionSkill(sessionId: string, revisionId: string): SkillRevision | undefined;
  unbindSessionSkill(sessionId: string): boolean;
}
