import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  decodeAbi,
  encodeAbi,
  OperatorSkillCatalogResponseSchema,
  OperatorSkillDeleteResponseSchema,
  OperatorSkillParamsSchema,
  OperatorSkillResponseSchema,
  OperatorSkillRevisionsResponseSchema,
  OperatorSkillUpdateRequestSchema,
  OperatorSkillUploadRequestSchema,
  OperatorWorkspaceSkillParamsSchema,
  OperatorWorkspaceSkillsReplaceRequestSchema,
  OperatorWorkspaceSkillsResponseSchema,
  type OperatorSkillRevision,
  type OperatorSkillSummary,
} from "@tagent/abi";
import type {
  ProfileMutationResult,
  ProfileSkillCatalogPage,
  ProfileSkillDeleteValue,
  ProfileSkillMutationValue,
  ProfileSkillRevisionPage,
  ProfileWorkspaceSkillPage,
  ProfileWorkspaceSkillsMutationValue,
} from "@tagent/admission/ports";
import type { SkillRevision, SkillSummary } from "@tagent/admission/domain";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { successEnvelope, V1HttpError } from "./errors.js";
import { decodeProfileCursor, encodeProfileCursor, encodeProfileSnapshot } from "./profile-cursor.js";
import {
  assertProfileResourceScope,
  authorizeProfile,
  profileListQuery,
  profileMutationContext,
  profileMutationHeaders,
  profileMutationValue,
  replayProfileMutation,
  setRevisionEtag,
} from "./profile-route-support.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function mapRevision(skill: SkillRevision): OperatorSkillRevision {
  return {
    id: skill.id,
    skillId: skill.skillId,
    revision: skill.revision,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    sha256: skill.sha256,
    disableModelInvocation: skill.disableModelInvocation,
    createdAt: new Date(skill.createdAt).toISOString(),
  };
}

function mapSummary(skill: SkillSummary, resourceRevision: number): OperatorSkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    latestRevision: skill.latestRevision,
    latestRevisionId: skill.latestRevisionId,
    description: skill.description,
    sha256: skill.sha256,
    workspaceCount: skill.workspaceCount,
    resourceRevision,
    updatedAt: new Date(skill.updatedAt).toISOString(),
  };
}

function pageState(request: Parameters<typeof profileListQuery>[0], kind: "skills" | "skill_revisions" | "workspace_skills", resourceId: string) {
  const query = profileListQuery(request, MAX_LIMIT);
  const limit = query.limit ?? DEFAULT_LIMIT;
  return {
    limit,
    state: query.cursor ? decodeProfileCursor(query.cursor, { kind, resourceId }) : {},
  };
}

function pageInfo(input: {
  kind: "skills" | "skill_revisions" | "workspace_skills";
  resourceId: string;
  snapshotRowId: number;
  limit: number;
  last?: { id: string; createdAt: number };
  hasMore: boolean;
}) {
  return {
    nextCursor: input.hasMore && input.last ? encodeProfileCursor({
      kind: input.kind,
      resourceId: input.resourceId,
      snapshotRowId: input.snapshotRowId,
      after: { createdAt: input.last.createdAt, id: input.last.id },
    }) : null,
    hasMore: input.hasMore,
    limit: input.limit,
    snapshot: encodeProfileSnapshot({ kind: input.kind, resourceId: input.resourceId, snapshotRowId: input.snapshotRowId }),
  };
}

function skillError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) throw new V1HttpError(404, "resource.not_found", message, "not_found");
  if (/already exists|duplicate/i.test(message)) throw new V1HttpError(409, "resource.state_conflict", message, "conflict");
  throw new V1HttpError(400, "skill.invalid", message, "validation");
}

type SkillMutationEffect = () => Promise<ProfileMutationResult<ProfileSkillMutationValue>> | ProfileMutationResult<ProfileSkillMutationValue>;

async function skillMutationResponse(request: FastifyRequest, reply: FastifyReply, effect: SkillMutationEffect) {
  try {
    const result = profileMutationValue(await effect());
    setRevisionEtag(reply, result.value.resourceRevision);
    if (result.replayed) reply.header("Idempotency-Replayed", "true");
    return encodeAbi(OperatorSkillResponseSchema, successEnvelope(request, {
      skill: mapRevision(result.value.skill), resourceRevision: result.value.resourceRevision,
      catalogRevision: result.value.catalogRevision,
    }));
  } catch (error) {
    if (error instanceof V1HttpError) throw error;
    return skillError(error);
  }
}

export function registerOperatorSkillV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  const read = authorizeProfile(dependencies, "operator:skills:read", "operator");
  const write = authorizeProfile(dependencies, "operator:skills:write", "operator");

  app.get("/api/v1/operator/skills", { onRequest: read }, async (request, reply) => {
    assertProfileResourceScope(request, "workspace", "*");
    const { limit, state } = pageState(request, "skills", "catalog");
    const page = dependencies.service.listSkillsProfile({ ...state, limit: limit + 1 }) as ProfileSkillCatalogPage;
    const rawItems = page.items.slice(0, limit);
    const lastOrderKey = page.orderKeys.slice(0, limit).at(-1);
    const items = rawItems.map((item) => {
      const detail = dependencies.service.getSkillProfile(item.id) as { resourceRevision: number };
      return mapSummary(item, detail.resourceRevision);
    });
    const hasMore = page.items.length > limit;
    setRevisionEtag(reply, page.collectionRevision);
    return encodeAbi(OperatorSkillCatalogResponseSchema, successEnvelope(request, {
      items,
      collectionRevision: page.collectionRevision,
      pageInfo: pageInfo({
        kind: "skills", resourceId: "catalog", snapshotRowId: page.snapshotRowId, limit, hasMore,
        ...(lastOrderKey ? { last: lastOrderKey } : {}),
      }),
    }));
  });

  app.get("/api/v1/operator/skills/:skillId", {
    onRequest: read,
    schema: { params: OperatorSkillParamsSchema },
  }, async (request, reply) => {
    assertProfileResourceScope(request, "workspace", "*");
    const { skillId } = request.params as { skillId: string };
    try {
      const result = dependencies.service.getSkillProfile(skillId) as {
        skill: SkillRevision; resourceRevision: number; catalogRevision: number;
      };
      setRevisionEtag(reply, result.resourceRevision);
      return encodeAbi(OperatorSkillResponseSchema, successEnvelope(request, {
        skill: mapRevision(result.skill),
        resourceRevision: result.resourceRevision,
        catalogRevision: result.catalogRevision,
      }));
    } catch (error) { return skillError(error); }
  });

  app.get("/api/v1/operator/skills/:skillId/revisions", {
    onRequest: read,
    schema: { params: OperatorSkillParamsSchema },
  }, async (request, reply) => {
    assertProfileResourceScope(request, "workspace", "*");
    const { skillId } = request.params as { skillId: string };
    const { limit, state } = pageState(request, "skill_revisions", skillId);
    try {
      const page = dependencies.service.listSkillRevisionsProfile(skillId, { ...state, limit: limit + 1 }) as ProfileSkillRevisionPage;
      const rawItems = page.items.slice(0, limit);
      const hasMore = page.items.length > limit;
      const last = rawItems.at(-1);
      setRevisionEtag(reply, page.resourceRevision);
      return encodeAbi(OperatorSkillRevisionsResponseSchema, successEnvelope(request, {
        items: rawItems.map(mapRevision),
        resourceRevision: page.resourceRevision,
        pageInfo: pageInfo({
          kind: "skill_revisions", resourceId: skillId, snapshotRowId: page.snapshotRowId, limit, hasMore,
          ...(last ? { last: { id: last.id, createdAt: last.createdAt } } : {}),
        }),
      }));
    } catch (error) { return skillError(error); }
  });

  app.post("/api/v1/operator/skills", {
    onRequest: write,
    schema: { body: OperatorSkillUploadRequestSchema },
  }, async (request, reply) => {
    assertProfileResourceScope(request, "workspace", "*");
    const body = decodeAbi(OperatorSkillUploadRequestSchema, request.body);
    const headers = profileMutationHeaders(request);
    const mutationContext = profileMutationContext(request, headers, body);
    return skillMutationResponse(request, reply, async () => {
      const replay = replayProfileMutation<ProfileSkillMutationValue>(dependencies, {
        profileId: "operator.skills.v1", endpointId: "operator.skills.create", resourceType: "skill_catalog", resourceId: "catalog",
      }, mutationContext);
      return replay ?? await dependencies.service.uploadSkillProfile(
        body, mutationContext,
      ) as ProfileMutationResult<ProfileSkillMutationValue>;
    });
  });

  app.patch("/api/v1/operator/skills/:skillId", {
    onRequest: write,
    schema: { params: OperatorSkillParamsSchema, body: OperatorSkillUpdateRequestSchema },
  }, async (request, reply) => {
    assertProfileResourceScope(request, "workspace", "*");
    const { skillId } = request.params as { skillId: string };
    const body = decodeAbi(OperatorSkillUpdateRequestSchema, request.body);
    const headers = profileMutationHeaders(request);
    const mutationContext = profileMutationContext(request, headers, body);
    return skillMutationResponse(request, reply, async () => {
      const replay = replayProfileMutation<ProfileSkillMutationValue>(dependencies, {
        profileId: "operator.skills.v1", endpointId: "operator.skills.update", resourceType: "skill", resourceId: skillId,
      }, mutationContext);
      return replay ?? await dependencies.service.updateSkillProfile(
        skillId, body, mutationContext,
      ) as ProfileMutationResult<ProfileSkillMutationValue>;
    });
  });

  app.delete("/api/v1/operator/skills/:skillId", {
    onRequest: write,
    schema: { params: OperatorSkillParamsSchema },
  }, async (request, reply) => {
    assertProfileResourceScope(request, "workspace", "*");
    const { skillId } = request.params as { skillId: string };
    const headers = profileMutationHeaders(request);
    const mutation = dependencies.service.deleteSkillProfile(
      skillId, profileMutationContext(request, headers, {}),
    ) as ProfileMutationResult<ProfileSkillDeleteValue>;
    const result = profileMutationValue(mutation);
    setRevisionEtag(reply, result.value.catalogRevision);
    if (result.replayed) reply.header("Idempotency-Replayed", "true");
    return encodeAbi(OperatorSkillDeleteResponseSchema, successEnvelope(request, result.value));
  });

  app.get("/api/v1/operator/workspaces/:workspaceId/skills", {
    onRequest: read,
    schema: { params: OperatorWorkspaceSkillParamsSchema },
  }, async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    assertProfileResourceScope(request, "workspace", workspaceId);
    const { limit, state } = pageState(request, "workspace_skills", workspaceId);
    try {
      const page = dependencies.service.listWorkspaceSkillsProfile(workspaceId, { ...state, limit: limit + 1 }) as ProfileWorkspaceSkillPage;
      const rawItems = page.items.slice(0, limit);
      const lastOrderKey = page.orderKeys.slice(0, limit).at(-1);
      const hasMore = page.items.length > limit;
      setRevisionEtag(reply, page.bindingRevision);
      return encodeAbi(OperatorWorkspaceSkillsResponseSchema, successEnvelope(request, {
        items: rawItems.map(mapRevision),
        bindingRevision: page.bindingRevision,
        pageInfo: pageInfo({
          kind: "workspace_skills", resourceId: workspaceId, snapshotRowId: page.snapshotRowId, limit, hasMore,
          ...(lastOrderKey ? { last: lastOrderKey } : {}),
        }),
      }));
    } catch (error) { return skillError(error); }
  });

  app.put("/api/v1/operator/workspaces/:workspaceId/skills", {
    onRequest: write,
    schema: { params: OperatorWorkspaceSkillParamsSchema, body: OperatorWorkspaceSkillsReplaceRequestSchema },
  }, async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    assertProfileResourceScope(request, "workspace", workspaceId);
    const body = decodeAbi(OperatorWorkspaceSkillsReplaceRequestSchema, request.body);
    const headers = profileMutationHeaders(request);
    const mutation = dependencies.service.replaceWorkspaceSkillsProfile(
      workspaceId, body.skillIds, profileMutationContext(request, headers, body),
    ) as ProfileMutationResult<ProfileWorkspaceSkillsMutationValue>;
    const result = profileMutationValue(mutation);
    setRevisionEtag(reply, result.value.bindingRevision);
    if (result.replayed) reply.header("Idempotency-Replayed", "true");
    return encodeAbi(OperatorWorkspaceSkillsResponseSchema, successEnvelope(request, {
      items: result.value.skills.map(mapRevision),
      bindingRevision: result.value.bindingRevision,
      pageInfo: {
        nextCursor: null,
        hasMore: false,
        limit: Math.max(1, result.value.skills.length),
        snapshot: encodeProfileSnapshot({ kind: "workspace_skills", resourceId: workspaceId, snapshotRowId: Number.MAX_SAFE_INTEGER }),
      },
    }));
  });
}
