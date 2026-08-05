import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  decodeAbi,
  encodeAbi,
  WorkflowEvaluationIdParamsSchema,
  WorkflowEvaluationRequestSchema,
  WorkflowEvaluationExecutionReceiptSchema,
  WorkflowEvaluationResponseSchema,
  WorkflowEvaluationVerificationSchema,
  WorkflowEvaluationVerificationResponseSchema,
  WorkflowEvaluationWorkflowParamsSchema,
} from "@tagent/abi";
import { authorizeV1 } from "./auth.js";
import type { V1ApiDependencies } from "./plugin.js";
import { successEnvelope, V1HttpError } from "./errors.js";
import { consoleError } from "./console-route-support.js";

export function registerInternalV1Routes(app: FastifyInstance, dependencies: V1ApiDependencies): void {
  const authorize = async (request: FastifyRequest): Promise<void> => {
    authorizeV1(request, dependencies.serviceCredentials, "internal", "internal");
  };

  app.post("/api/v1/internal/workflows/:id/evaluate", {
    onRequest: authorize,
    schema: { params: WorkflowEvaluationWorkflowParamsSchema, body: WorkflowEvaluationRequestSchema },
  }, async (request) => {
    const { id } = decodeAbi(WorkflowEvaluationWorkflowParamsSchema, request.params);
    const body = decodeAbi(WorkflowEvaluationRequestSchema, request.body);
    let rawResult: unknown;
    try {
      rawResult = dependencies.service.executeWorkflowEvaluation({
        workflowId: id,
        candidateRevisionId: body.candidateRevisionId,
        baselineRevisionId: body.baselineRevisionId,
        kind: body.kind,
        datasetId: body.datasetId,
        baselineRunIds: body.baselineRunIds ?? [],
        candidateRunIds: body.candidateRunIds ?? [],
      });
    } catch (error) {
      throw consoleError(409, "evaluation.conflict", error instanceof Error ? error.message : String(error));
    }
    const result = decodeAbi(WorkflowEvaluationExecutionReceiptSchema, rawResult);
    return encodeAbi(WorkflowEvaluationResponseSchema, successEnvelope(request, result));
  });

  app.get("/api/v1/internal/workflow-evaluations/:id/verify", {
    onRequest: authorize,
    schema: { params: WorkflowEvaluationIdParamsSchema },
  }, async (request) => {
    const { id } = decodeAbi(WorkflowEvaluationIdParamsSchema, request.params);
    const verified = decodeAbi(
      WorkflowEvaluationVerificationSchema,
      dependencies.service.verifyWorkflowEvaluation(id),
    );
    return encodeAbi(
      WorkflowEvaluationVerificationResponseSchema,
      successEnvelope(request, verified),
    );
  });

  app.all("/api/v1/internal/*", { onRequest: authorize }, async () => {
    throw new V1HttpError(404, "route.not_found", "Internal v1 route not found", "not_found", false, { surface: "internal" });
  });
}
