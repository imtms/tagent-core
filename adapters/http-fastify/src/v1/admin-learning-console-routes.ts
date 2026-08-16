import type { FastifyInstance } from "fastify";
import type { HttpApplicationPort } from "../ports/index.js";
import type { V1ApiDependencies } from "./plugin.js";
import { successEnvelope } from "./errors.js";
import { authorizeConsole, consoleError } from "./console-route-support.js";

export function registerAdminLearningConsoleV1Routes(app: FastifyInstance, dependencies: V1ApiDependencies): void {
  const { service, persistence, learningControl, memory, runtimeConfig } = dependencies;
  const { sessions, taskRuns } = persistence;
  const admin = authorizeConsole(dependencies, "admin", "admin");
  const govern = authorizeConsole(dependencies, "workflows:govern", "admin");
  const approve = authorizeConsole(dependencies, "workflows:approve", "admin");

  app.get("/api/v1/admin/config/status", { onRequest: admin }, async (request) => {
    const learning = learningControl?.snapshot();
    const status = runtimeConfig ? { ...runtimeConfig, ...(learning ? { ...learning, memoryEnabled: learning.memoryEnabled, memoryRuntimeEnabled: learning.memoryEnabled } : {}) } : null;
    return successEnvelope(request, status);
  });

  app.get("/api/v1/admin/console/learning/settings", { onRequest: admin }, async (request) =>
    successEnvelope(request, learningControl?.snapshot() ?? {
      memoryAvailable: Boolean(memory), memoryEnabled: Boolean(memory), learningEnabled: false,
      autoExecutionEnabled: false, passiveLearningEnabled: false,
      activeExecutionRequiresApproval: true, updatedAt: 0, reason: "learning_control_unavailable",
    }));

  app.patch("/api/v1/admin/console/learning/settings", { onRequest: admin }, async (request) => {
    if (!learningControl) throw consoleError(503, "learning.control_unavailable", "learning feature control is unavailable");
    const body = (request.body ?? {}) as { memoryEnabled?: boolean; learningEnabled?: boolean; autoExecutionEnabled?: boolean; reason?: string };
    for (const field of ["memoryEnabled", "learningEnabled", "autoExecutionEnabled"] as const) {
      if (body[field] !== undefined && typeof body[field] !== "boolean") throw consoleError(400, "learning.setting_invalid", `${field} must be boolean`);
    }
    try {
      const result = await service.updateLearningSettings({ ...body, reason: body.reason ?? "web_ui" });
      return successEnvelope(request, result);
    } catch (error) {
      throw consoleError(409, "learning.update_conflict", error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/v1/admin/sessions/:id/learning-center", { onRequest: govern }, async (request) => {
    const { id } = request.params as { id: string };
    if (!sessions.getSession(id)) throw consoleError(404, "session.not_found", "session not found");
    return successEnvelope(request, service.getLearningCenter(id));
  });

  app.post("/api/v1/admin/workflows/:id/activation-request", { onRequest: govern }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { revisionId?: string; actor?: string; reason?: string };
    try { return successEnvelope(request, service.requestWorkflowActivation(id, body.revisionId, body.actor ?? "learning_center", body.reason)); }
    catch (error) { throw consoleError(409, "workflow.activation_conflict", error instanceof Error ? error.message : String(error)); }
  });

  app.post("/api/v1/admin/workflows/:id/activate", { onRequest: approve }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { revisionId?: string; approvalId?: string };
    if (!body.approvalId) throw consoleError(409, "workflow.approval_required", "Human approval is required");
    try { return successEnvelope(request, service.activateWorkflow(id, body.revisionId, body.approvalId)); }
    catch (error) { throw consoleError(409, "workflow.activation_conflict", error instanceof Error ? error.message : String(error)); }
  });

  app.post("/api/v1/admin/workflows/:id/suspend", { onRequest: govern }, async (request) => {
    const { id } = request.params as { id: string };
    try { return successEnvelope(request, service.suspendWorkflow(id, (request.body as { reason?: string } | undefined)?.reason)); }
    catch (error) { throw consoleError(404, "workflow.not_found", error instanceof Error ? error.message : String(error)); }
  });

  app.delete("/api/v1/admin/workflows/:id", { onRequest: govern }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { reason?: string; gracePeriodMs?: number };
    if (!service.forgetWorkflow(id, body.reason, body.gracePeriodMs)) throw consoleError(404, "workflow.not_found", "workflow not found");
    return successEnvelope(request, { ok: true });
  });

  app.post("/api/v1/admin/workflows/:id/restore", { onRequest: govern }, async (request) => {
    try { return successEnvelope(request, service.restoreWorkflow((request.params as { id: string }).id)); }
    catch (error) { throw consoleError(409, "workflow.restore_conflict", error instanceof Error ? error.message : String(error)); }
  });

  for (const decision of ["approve", "reject"] as const) {
    app.post(`/api/v1/admin/workflow-proposals/:id/${decision}`, { onRequest: govern }, async (request) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { actor?: string; reason?: string };
      try { return successEnvelope(request, service.decideWorkflowProposal(id, decision === "approve" ? "approved" : "rejected", body.actor ?? "learning_center", body.reason)); }
      catch (error) { throw consoleError(409, "workflow.proposal_conflict", error instanceof Error ? error.message : String(error)); }
    });
  }

  app.post("/api/v1/admin/workflow-proposals/:id/application-request", { onRequest: govern }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { actor?: string; reason?: string };
    try { return successEnvelope(request, service.requestWorkflowProposalApplication(id, body.actor ?? "learning_center", body.reason)); }
    catch (error) { throw consoleError(409, "workflow.proposal_conflict", error instanceof Error ? error.message : String(error)); }
  });

  app.post("/api/v1/admin/workflow-proposals/:id/apply", { onRequest: approve }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { actor?: string; approvalId?: string };
    if (!body.approvalId) throw consoleError(409, "workflow.approval_required", "Human approval is required");
    try { return successEnvelope(request, service.applyWorkflowProposal(id, body.actor ?? "learning_center", body.approvalId)); }
    catch (error) { throw consoleError(409, "workflow.proposal_conflict", error instanceof Error ? error.message : String(error)); }
  });

  for (const action of ["approve", "reject", "revoke", "execute"] as const) {
    app.post(`/api/v1/admin/autonomy-approvals/:id/${action}`, { onRequest: approve }, async (request) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { actor?: string; reason?: string };
      const actor = body.actor ?? "learning_center_human";
      try {
        const result = action === "execute" ? service.executeAutonomyApproval(id, actor)
          : action === "revoke" ? service.revokeAutonomyApproval(id, actor, body.reason)
          : service.decideAutonomyApproval(id, action === "approve" ? "approved" : "rejected", actor, body.reason);
        return successEnvelope(request, result);
      } catch (error) {
        throw consoleError(409, "autonomy.approval_conflict", error instanceof Error ? error.message : String(error));
      }
    });
  }

  app.post("/api/v1/admin/task-runs/:id/learning-policy", { onRequest: govern }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { policy?: "allow" | "metadata_only" | "deny"; reason?: string };
    if (!taskRuns.hasRun(id)) throw consoleError(404, "task_run.not_found", "TaskRun not found");
    if (!body.policy) throw consoleError(400, "learning.policy_required", "policy is required");
    return successEnvelope(request, service.setRunLearningPolicy(id, body.policy, body.reason));
  });

  app.post("/api/v1/admin/workflow-bindings/:id/application", { onRequest: approve }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as Omit<Parameters<HttpApplicationPort["recordWorkflowApplication"]>[0], "bindingId">;
    if (!body.status) throw consoleError(400, "workflow.application_status_required", "status is required");
    try { return successEnvelope(request, service.recordWorkflowApplication({ bindingId: id, ...body })); }
    catch (error) { throw consoleError(400, "workflow.application_invalid", error instanceof Error ? error.message : String(error)); }
  });

  app.post("/api/v1/admin/workflow-distillation/run", { onRequest: govern }, async (request) =>
    successEnvelope(request, service.runWorkflowDistiller(((request.body ?? {}) as { owner?: string }).owner)));

  app.post("/api/v1/admin/workflow-distillation/:id/retry", { onRequest: govern }, async (request) => {
    try { return successEnvelope(request, service.retryWorkflowDistillation((request.params as { id: string }).id, request.body as { taskSignature?: string })); }
    catch (error) { throw consoleError(409, "workflow.distillation_conflict", error instanceof Error ? error.message : String(error)); }
  });
}
