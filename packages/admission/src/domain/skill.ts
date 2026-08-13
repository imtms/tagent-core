/** Immutable, validated Skill revision managed by Core. */
export interface SkillRevision {
  id: string;
  skillId: string;
  revision: number;
  name: string;
  description: string;
  content: string;
  /** Workspace-relative path to the revision's SKILL.md. */
  filePath: string;
  sha256: string;
  disableModelInvocation: boolean;
  sourceFilename: string;
  createdAt: number;
}

export interface SkillSummary {
  id: string;
  name: string;
  latestRevision: number;
  latestRevisionId: string;
  description: string;
  sha256: string;
  workspaceCount: number;
  updatedAt: number;
}

export interface CreateSkillRevisionInput {
  /** Existing catalog identity when editing; omitted for a new upload. */
  skillId?: string;
  name: string;
  description: string;
  content: string;
  filePath: string;
  sha256: string;
  disableModelInvocation?: boolean;
  sourceFilename: string;
}

export interface UpdateSkillInput {
  name: string;
  description: string;
  content: string;
  disableModelInvocation?: boolean;
}
