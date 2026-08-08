import type {
  ConsoleCreateWorkspaceGoalRequest,
  ConsoleDecideWorkspaceGoalRequest,
  ConsoleGenerateWorkspaceGoalRoadmapRequest,
  ConsoleReviseWorkspaceGoalDefinitionRequest,
  ConsoleReviseWorkspaceGoalRoadmapRequest,
  ConsoleStartWorkspaceGoalTaskRunRequest,
  ConsoleStartWorkspaceGoalTaskRunResult,
  ConsoleWorkspaceGoal,
  ConsoleWorkspaceGoalOperationReceipt,
  ConsoleWorkspaceGoalRevision,
  ConsoleWorkspaceGoalSummary,
} from "@tagent/abi";
import { loadCoreAbi } from "./abi-loader.js";
import { protocolError } from "./errors.js";
import { CoreTransport } from "./transport.js";

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function validateGoalRequest<T>(method: string, url: string, input: unknown, decode: (value: unknown) => T): T {
  try { return decode(input); }
  catch (error) {
    throw protocolError(method, url, `TAgent Core request validation failed: ${error instanceof Error ? error.message : String(error)}`, "", {}, error);
  }
}

export class ConsoleGoalClient extends CoreTransport {
  async listWorkspaceGoals(workspaceId: string): Promise<ConsoleWorkspaceGoalSummary[]> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/console/workspaces/${encodePathSegment(workspaceId)}/goals`;
    return this.request(path, { decode: (payload) => abi.decodeAbi(abi.ConsoleWorkspaceGoalSummariesSchema, abi.decodeAbi(abi.SuccessEnvelopeSchema, payload).data) });
  }

  async getWorkspaceGoal(goalId: string): Promise<ConsoleWorkspaceGoal> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/console/workspace-goals/${encodePathSegment(goalId)}`;
    return this.request(path, { decode: (payload) => abi.decodeAbi(abi.ConsoleWorkspaceGoalSchema, abi.decodeAbi(abi.SuccessEnvelopeSchema, payload).data) });
  }

  async createWorkspaceGoal(workspaceId: string, input: ConsoleCreateWorkspaceGoalRequest): Promise<ConsoleWorkspaceGoal> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/console/workspaces/${encodePathSegment(workspaceId)}/goals`;
    const body = validateGoalRequest("POST", this.resolve(path), input, (value) => abi.decodeAbi(abi.ConsoleCreateWorkspaceGoalRequestSchema, value));
    return this.request(path, {
      decode: (payload) => abi.decodeAbi(abi.ConsoleWorkspaceGoalSchema, abi.decodeAbi(abi.SuccessEnvelopeSchema, payload).data),
      idempotent: true, json: body, method: "POST", requestId: body.requestId,
    });
  }

  async reviseWorkspaceGoalDefinition(goalId: string, input: ConsoleReviseWorkspaceGoalDefinitionRequest): Promise<ConsoleWorkspaceGoalRevision> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/console/workspace-goals/${encodePathSegment(goalId)}/definition-revisions`;
    const body = validateGoalRequest("POST", this.resolve(path), input, (value) => abi.decodeAbi(abi.ConsoleReviseWorkspaceGoalDefinitionRequestSchema, value));
    return this.request(path, {
      decode: (payload) => abi.decodeAbi(abi.ConsoleWorkspaceGoalRevisionSchema, abi.decodeAbi(abi.SuccessEnvelopeSchema, payload).data),
      idempotent: true, json: body, method: "POST", requestId: body.requestId,
    });
  }

  async reviseWorkspaceGoalRoadmap(goalId: string, input: ConsoleReviseWorkspaceGoalRoadmapRequest): Promise<ConsoleWorkspaceGoal> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/console/workspace-goals/${encodePathSegment(goalId)}/roadmaps`;
    const body = validateGoalRequest("POST", this.resolve(path), input, (value) => abi.decodeAbi(abi.ConsoleReviseWorkspaceGoalRoadmapRequestSchema, value));
    return this.request(path, {
      decode: (payload) => abi.decodeAbi(abi.ConsoleWorkspaceGoalSchema, abi.decodeAbi(abi.SuccessEnvelopeSchema, payload).data),
      idempotent: true, json: body, method: "POST", requestId: body.requestId,
    });
  }

  async generateWorkspaceGoalRoadmap(goalId: string, input: ConsoleGenerateWorkspaceGoalRoadmapRequest): Promise<ConsoleWorkspaceGoal> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/console/workspace-goals/${encodePathSegment(goalId)}/roadmap/generate`;
    const body = validateGoalRequest("POST", this.resolve(path), input, (value) => abi.decodeAbi(abi.ConsoleGenerateWorkspaceGoalRoadmapRequestSchema, value));
    return this.request(path, {
      decode: (payload) => abi.decodeAbi(abi.ConsoleWorkspaceGoalSchema, abi.decodeAbi(abi.SuccessEnvelopeSchema, payload).data),
      idempotent: true,
      json: body,
      method: "POST",
      requestId: body.requestId,
    });
  }

  async decideWorkspaceGoal(goalId: string, input: ConsoleDecideWorkspaceGoalRequest): Promise<ConsoleWorkspaceGoal> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/console/workspace-goals/${encodePathSegment(goalId)}/decisions`;
    const body = validateGoalRequest("POST", this.resolve(path), input, (value) => abi.decodeAbi(abi.ConsoleDecideWorkspaceGoalRequestSchema, value));
    return this.request(path, {
      decode: (payload) => abi.decodeAbi(abi.ConsoleWorkspaceGoalSchema, abi.decodeAbi(abi.SuccessEnvelopeSchema, payload).data),
      idempotent: true, json: body, method: "POST", requestId: body.requestId,
    });
  }

  async startWorkspaceGoalTaskRun(goalId: string, input: ConsoleStartWorkspaceGoalTaskRunRequest): Promise<ConsoleStartWorkspaceGoalTaskRunResult> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/console/workspace-goals/${encodePathSegment(goalId)}/task-runs`;
    const body = validateGoalRequest("POST", this.resolve(path), input, (value) => abi.decodeAbi(abi.ConsoleStartWorkspaceGoalTaskRunRequestSchema, value));
    return this.request(path, {
      decode: (payload) => abi.decodeAbi(abi.ConsoleStartWorkspaceGoalTaskRunResultSchema, abi.decodeAbi(abi.SuccessEnvelopeSchema, payload).data),
      idempotent: true, json: body, method: "POST", requestId: body.requestId,
    });
  }

  async getWorkspaceGoalOperation(goalId: string, requestId: string): Promise<ConsoleWorkspaceGoalOperationReceipt> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/console/workspace-goals/${encodePathSegment(goalId)}/operations/${encodePathSegment(requestId)}`;
    return this.request(path, { decode: (payload) => abi.decodeAbi(abi.ConsoleWorkspaceGoalOperationReceiptSchema, abi.decodeAbi(abi.SuccessEnvelopeSchema, payload).data) });
  }
}
