import type {
  OperatorSkillCatalogResponse,
  OperatorSkillResponse,
  OperatorWorkspaceSkillsResponse,
} from "./schemas.js";

export const operatorSkillFixture = {
  id: "skill-revision-fixture-1",
  skillId: "skill-fixture-1",
  revision: 2,
  name: "release-check",
  description: "Validate a release before publishing.",
  content: "Run the release checks and record their evidence.",
  sha256: "a".repeat(64),
  disableModelInvocation: false,
  createdAt: "2026-08-14T12:00:00.000Z",
} as const;

export const operatorSkillCatalogFixture = {
  data: {
    items: [{
      id: "skill-fixture-1",
      name: "release-check",
      latestRevision: 2,
      latestRevisionId: "skill-revision-fixture-1",
      description: "Validate a release before publishing.",
      sha256: "a".repeat(64),
      workspaceCount: 1,
      resourceRevision: 2,
      updatedAt: "2026-08-14T12:00:00.000Z",
    }],
    collectionRevision: 4,
    pageInfo: { nextCursor: null, hasMore: false, limit: 50, snapshot: "opaque-skill-catalog-snapshot" },
  },
  requestId: "request-skill-catalog-001",
} as const satisfies OperatorSkillCatalogResponse;

export const operatorSkillResponseFixture = {
  data: { skill: operatorSkillFixture, resourceRevision: 2, catalogRevision: 4 },
  requestId: "request-skill-get-001",
} as const satisfies OperatorSkillResponse;

export const operatorWorkspaceSkillsFixture = {
  data: {
    items: [operatorSkillFixture],
    bindingRevision: 3,
    pageInfo: { nextCursor: null, hasMore: false, limit: 50, snapshot: "opaque-workspace-skill-snapshot" },
  },
  requestId: "request-workspace-skills-001",
} as const satisfies OperatorWorkspaceSkillsResponse;
