import type {
  ConsoleGenerateWorkspaceGoalRoadmapRequest,
  ConsoleWorkspaceGoal,
  ConsoleWorkspaceGoalOperationReceipt,
  ConsoleWorkspaceGoalSummary,
} from "@tagent/abi";
import { loadCoreAbi } from "./abi-loader.js";
import { protocolError } from "./errors.js";
import { CoreTransport } from "./transport.js";

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
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

  async generateWorkspaceGoalRoadmap(goalId: string, input: ConsoleGenerateWorkspaceGoalRoadmapRequest): Promise<ConsoleWorkspaceGoal> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/console/workspace-goals/${encodePathSegment(goalId)}/roadmap/generate`;
    let body: ConsoleGenerateWorkspaceGoalRoadmapRequest;
    try {
      body = abi.decodeAbi(abi.ConsoleGenerateWorkspaceGoalRoadmapRequestSchema, input);
    } catch (error) {
      throw protocolError("POST", this.resolve(path), `TAgent Core request validation failed: ${error instanceof Error ? error.message : String(error)}`, "", {}, error);
    }
    return this.request(path, {
      decode: (payload) => abi.decodeAbi(abi.ConsoleWorkspaceGoalSchema, abi.decodeAbi(abi.SuccessEnvelopeSchema, payload).data),
      idempotent: true,
      json: body,
      method: "POST",
      requestId: body.requestId,
    });
  }

  async getWorkspaceGoalOperation(goalId: string, requestId: string): Promise<ConsoleWorkspaceGoalOperationReceipt> {
    const abi = await loadCoreAbi();
    const path = `/api/v1/console/workspace-goals/${encodePathSegment(goalId)}/operations/${encodePathSegment(requestId)}`;
    return this.request(path, { decode: (payload) => abi.decodeAbi(abi.ConsoleWorkspaceGoalOperationReceiptSchema, abi.decodeAbi(abi.SuccessEnvelopeSchema, payload).data) });
  }
}
