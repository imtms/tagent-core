import type { CreateSkillRevisionInput, SkillRevision, SkillSummary } from "../domain/skill.js";
import type { ProfileMutationContext, ProfileMutationResult, ProfilePageQuery } from "./profile-contract-repository.js";

export interface ProfileSkillCatalogPage {
  items: SkillSummary[];
  orderKeys: Array<{ createdAt: number; id: string }>;
  snapshotRowId: number;
  collectionRevision: number;
}

export interface ProfileSkillRevisionPage {
  items: SkillRevision[];
  snapshotRowId: number;
  resourceRevision: number;
}

export interface ProfileWorkspaceSkillPage {
  items: SkillRevision[];
  orderKeys: Array<{ createdAt: number; id: string }>;
  snapshotRowId: number;
  bindingRevision: number;
}

export interface ProfileSkillMutationValue {
  skill: SkillRevision;
  resourceRevision: number;
  catalogRevision: number;
}

export interface ProfileSkillDeleteValue {
  ok: true;
  skillId: string;
  catalogRevision: number;
}

export interface ProfileWorkspaceSkillsMutationValue {
  skills: SkillRevision[];
  bindingRevision: number;
}

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
  getCatalogRevision(): number;
  getSkillResourceRevision(skillId: string): number | undefined;
  getWorkspaceSkillRevision(workspaceId: string): number | undefined;
  listProfileSkillsPage(query: ProfilePageQuery): ProfileSkillCatalogPage;
  listProfileSkillRevisionsPage(skillId: string, query: ProfilePageQuery): ProfileSkillRevisionPage | undefined;
  listProfileWorkspaceSkillsPage(workspaceId: string, query: ProfilePageQuery): ProfileWorkspaceSkillPage | undefined;
  createRevisionProfile(input: CreateSkillRevisionInput, mutation: ProfileMutationContext): ProfileMutationResult<ProfileSkillMutationValue>;
  deleteSkillProfile(skillId: string, mutation: ProfileMutationContext): ProfileMutationResult<ProfileSkillDeleteValue>;
  replaceWorkspaceSkillsProfile(
    workspaceId: string,
    skillIds: readonly string[],
    mutation: ProfileMutationContext,
  ): ProfileMutationResult<ProfileWorkspaceSkillsMutationValue>;
}
