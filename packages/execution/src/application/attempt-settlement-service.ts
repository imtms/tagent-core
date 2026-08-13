import { randomUUID } from "node:crypto";
import type { AttemptExecutionToken, AttemptRuntimePort } from "../ports/attempt-runtime.js";
import type { RunId } from "../domain/task-run.js";
import type { CandidateResult } from "../domain/index.js";
import type { ExecutionStateView } from "./execution-state.js";
import { ensureSettlementApproval } from "./settlement-approval.js";
import { blockRuntimeTaskRun, canonicalGateEvaluations, completeRuntimeTaskRun, publishTransitionOutcome } from "./task-run-transition-helpers.js";
import { executeRuntimePrompt } from "./runtime-skill.js";
import type {
  AttemptProjectionPort,
  RecoveryControlPort,
  RunEventPublisherPort,
  SupervisorPort,
} from "./collaboration-ports.js";

type AttemptSettlementState = ExecutionStateView<
  | "closing" | "continuationOwner" | "persistence",
  | "approvals" | "attemptAuthority" | "attempts" | "checkpoints"
  | "continuations" | "events" | "sessions" | "taskRuns" | "taskRunTransitions"
>;

const authoritativeSettlementRejected = Symbol("authoritative-settlement-rejected");
type AuthoritativeSettlementRejection = {
  readonly kind: typeof authoritativeSettlementRejected;
  readonly message: string;
  readonly supervisorDecisionId?: string;
};

function isAuthoritativeSettlementRejection(error: unknown): error is AuthoritativeSettlementRejection {
  return typeof error === "object" && error !== null
    && "kind" in error && error.kind === authoritativeSettlementRejected;
}

export class AttemptSettlementService {
  constructor(
    private readonly state: AttemptSettlementState,
    private readonly dependencies: {
      eventHub: RunEventPublisherPort;
      projection: AttemptProjectionPort;
      recovery: RecoveryControlPort;
      supervisor: SupervisorPort;
    },
  ) {}
  public projectWorkflowExperience(runId: RunId) {
    this.dependencies.projection.project(runId);
  }

  public async execute(runId: RunId, token: AttemptExecutionToken, runtime: AttemptRuntimePort, prompt: string, continuationId?: string, onRuntimeSettled: () => void = () => {}) {
    let candidateResponse = "";
    let canaryCandidate: CandidateResult | undefined;
    try {
      try {
        await executeRuntimePrompt(runtime, prompt, this.state.persistence.taskRuns.getRun(runId)?.contract?.skill?.name);
      } finally {
        // The Run idle watchdog covers active Agent/runtime work only. Supervisor
        // review has its own bounded SSE idle timeout and must not be raced by it.
        onRuntimeSettled();
      }
      const runtimeError = runtime.getError();
      if (runtimeError) throw new Error(runtimeError);
      if (continuationId && !this.state.persistence.continuations.ownsContinuationLease(continuationId, this.state.continuationOwner)) {
        this.dependencies.recovery.recoverContinuations();
        return false;
      }
      const current = this.state.persistence.taskRuns.getRun(runId);
      if (!current || current.status === "waiting_input") return false;
      if (current.status !== "running") return false;
      const messages = runtime.getMessages();
      const checkpointResponse = this.state.persistence.checkpoints.getCheckpoint(runId)?.assistantPartial.trim() ?? "";
      const assistantMessages = messages.filter((message) => message.role === "assistant" && "content" in message);
      const assistantResponses = assistantMessages
        .map((message) => typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join(""))
        .map((value) => value.trim())
        .filter(Boolean);
      const response = checkpointResponse || assistantResponses.at(-1) || "";
      candidateResponse = response;
      canaryCandidate = this.recordCanaryCandidate(token, response);
      const finalAssistant = assistantMessages.at(-1);
      const modelOutputTruncated = finalAssistant && "stopReason" in finalAssistant && finalAssistant.stopReason === "length";
      const checkpointSeq = this.state.persistence.checkpoints.getCheckpoint(runId)?.lastEventSeq ?? current.lastEventSeq;
      const review = await this.dependencies.supervisor.reviewSettled(current, checkpointSeq, response, { modelOutputTruncated });
      const canonicalGates = canonicalGateEvaluations(review.gates);
      const decision = review.decision;
      const reviewedRun = this.state.persistence.taskRuns.getRun(runId);
      if (!reviewedRun || reviewedRun.status !== "running" || reviewedRun.attempt !== decision.attempt) {
        this.dependencies.supervisor.markExecuted(decision.id, "superseded");
        return false;
      }
      if (decision.action === "complete_taskrun") {
        const authoritative = this.settleAuthoritatively(token, canaryCandidate, decision.id, decision.action, "completed", "");
        if (authoritative !== undefined) return authoritative;
        const transition = completeRuntimeTaskRun(this.state.persistence.taskRunTransitions, token, {
          response, supervisionDecisionId: decision.id, gates: canonicalGates,
        });
        if (response) this.state.persistence.sessions.appendMessage(current.sessionId, "assistant", response);
        this.dependencies.supervisor.markExecuted(decision.id, "executed");
        publishTransitionOutcome(this.dependencies.eventHub, transition);
        this.projectWorkflowExperience(runId);
        return false;
      }
      const reason = review.gates.find((gate) => gate.gateType === "completion")?.failures.map((failure) => `${failure.key}: ${failure.reason}`).join("; ") || decision.rationale;
      const authoritative = this.settleAuthoritatively(token, canaryCandidate, decision.id, decision.action, "blocked", reason);
      if (authoritative !== undefined) return authoritative;
      const transition = blockRuntimeTaskRun(
        this.state.persistence.taskRunTransitions,
        token,
        reason,
        { response, supervisionDecisionId: decision.id, action: decision.action, gates: canonicalGates },
        [{
          kind: "message_rejected",
          data: { response, reason, supervisionDecisionId: decision.id, action: decision.action },
        }],
      );
      this.dependencies.supervisor.markExecuted(decision.id, "executed");
      publishTransitionOutcome(this.dependencies.eventHub, transition);
      this.projectWorkflowExperience(runId);
      if (decision.action === "pause_for_approval") {
        const approval = ensureSettlementApproval(this.state.persistence.approvals, current, decision.id, reason);
        this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(runId, "supervisor.approval.requested", { approvalId: approval.id, decisionId: decision.id, reason }));
      }
      return decision.action === "start_continuation" || decision.action === "request_evidence" || decision.action === "wait_for_runtime";
    } catch (error) {
      if (this.state.closing) return false;
      if (isAuthoritativeSettlementRejection(error)) {
        this.recoverInterruptedAttempt(token, error.message, error.supervisorDecisionId);
        return false;
      }
      if (continuationId && !this.state.persistence.continuations.ownsContinuationLease(continuationId, this.state.continuationOwner)) {
        this.dependencies.recovery.recoverContinuations();
        return false;
      }
      const current = this.state.persistence.taskRuns.getRun(runId);
      if (!current || current.status !== "running") return false;
      const message = error instanceof Error ? error.message : String(error);
      const checkpointSeq = this.state.persistence.checkpoints.getCheckpoint(runId)?.lastEventSeq ?? current.lastEventSeq;
      if (this.dependencies.supervisor.isReviewError(error)) {
        const decision = this.dependencies.supervisor.recordReviewFailure(current, checkpointSeq, message);
        try {
          const authoritative = this.settleAuthoritatively(
            token,
            canaryCandidate,
            decision.id,
            decision.action,
            "blocked",
            "Supervisor review failed after bounded internal retries. The candidate result was preserved and the Agent was not rerun.",
          );
          if (authoritative !== undefined) return authoritative;
        } catch (settlementError) {
          if (isAuthoritativeSettlementRejection(settlementError)) {
            this.recoverInterruptedAttempt(token, settlementError.message, settlementError.supervisorDecisionId);
            return false;
          }
          throw settlementError;
        }
        const transition = blockRuntimeTaskRun(
          this.state.persistence.taskRunTransitions,
          token,
          "Supervisor review failed after bounded internal retries. The candidate result was preserved and the Agent was not rerun.",
          { error: message, reason: decision.reasonCode, action: decision.action, supervisionDecisionId: decision.id },
        );
        this.dependencies.supervisor.markExecuted(decision.id, "executed");
        this.state.persistence.sessions.appendMessage(current.sessionId, "assistant", "Run blocked: Supervisor quality review failed after bounded internal retries. The Agent result was preserved for audit; no automatic continuation was started.");
        publishTransitionOutcome(this.dependencies.eventHub, transition);
        this.projectWorkflowExperience(runId);
        return false;
      }
      try {
        canaryCandidate ??= this.recordCanaryCandidate(token, candidateResponse);
      } catch (settlementError) {
        if (isAuthoritativeSettlementRejection(settlementError)) {
          this.recoverInterruptedAttempt(token, settlementError.message, settlementError.supervisorDecisionId);
          return false;
        }
        throw settlementError;
      }
      const decision = await this.dependencies.supervisor.reviewAttemptFailure(current, checkpointSeq, message);
      const recoverable = decision.action === "start_continuation";
      try {
        const authoritative = this.settleAuthoritatively(token, canaryCandidate, decision.id, decision.action, "blocked", message);
        if (authoritative !== undefined) return authoritative;
      } catch (settlementError) {
        if (isAuthoritativeSettlementRejection(settlementError)) {
          this.recoverInterruptedAttempt(token, settlementError.message, settlementError.supervisorDecisionId);
          return false;
        }
        throw settlementError;
      }
      const transition = blockRuntimeTaskRun(
        this.state.persistence.taskRunTransitions,
        token,
        message,
        { error: message, reason: decision.reasonCode, action: decision.action, supervisionDecisionId: decision.id },
      );
      this.dependencies.supervisor.markExecuted(decision.id, "executed");
      if (decision.action === "pause_for_approval") {
        const approval = ensureSettlementApproval(this.state.persistence.approvals, current, decision.id, message);
        this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(runId, "supervisor.approval.requested", { approvalId: approval.id, decisionId: decision.id, reason: message }));
      }
      this.state.persistence.sessions.appendMessage(current.sessionId, "assistant", decision.action === "pause_for_approval" ? `Run paused for approval: ${message}` : `Run blocked: ${message}`);
      publishTransitionOutcome(this.dependencies.eventHub, transition);
      this.projectWorkflowExperience(runId);
      return recoverable;
    }
  }

  private recordCanaryCandidate(token: AttemptExecutionToken, response: string): CandidateResult | undefined {
    const authority = this.state.persistence.attemptAuthority.getAuthorityState();
    if (authority.mode !== "canary" || authority.status !== "approved"
      || authority.approvedAttemptId !== token.attemptId) return undefined;
    try {
      this.state.persistence.attemptAuthority.assertAttemptApproved(token.attemptId);
      const current = this.state.persistence.taskRuns.getRun(token.runId);
      if (!current || current.attempt !== token.ordinal || current.status !== "running") {
        throw new Error(`TaskRun projection is stale for Attempt ${token.attemptId}`);
      }
      return this.state.persistence.attempts.recordCandidateResult({
        id: randomUUID(),
        attemptId: token.attemptId,
        expectedVersion: token.expectedVersion,
        leaseToken: token.leaseToken,
        fence: token.executionFence,
        response,
      });
    } catch (error) {
      throw {
        kind: authoritativeSettlementRejected,
        message: error instanceof Error ? error.message : String(error),
      } satisfies AuthoritativeSettlementRejection;
    }
  }

  private settleAuthoritatively(
    token: AttemptExecutionToken, candidate: CandidateResult | undefined,
    supervisorDecisionId: string, action: string, status: "completed" | "blocked", reason: string,
  ): boolean | undefined {
    if (!candidate) return undefined;
    try {
      this.state.persistence.attemptAuthority.assertAttemptApproved(token.attemptId);
      const current = this.state.persistence.taskRuns.getRun(token.runId);
      if (!current || current.attempt !== token.ordinal || current.status !== "running") {
        throw new Error(`TaskRun projection is stale for Attempt ${token.attemptId}`);
      }
      if (!candidate || candidate.attemptId !== token.attemptId) {
        throw new Error(`Candidate result is unavailable for Attempt ${token.attemptId}`);
      }
      this.state.persistence.attempts.settleAttempt({
        attemptId: token.attemptId,
        expectedVersion: candidate.attemptVersion,
        leaseToken: token.leaseToken,
        fence: token.executionFence,
        candidateResultId: candidate.id,
        supervisorDecisionId,
        status,
        reason,
      });
      for (const event of this.state.persistence.events.listEvents(token.runId, current.lastEventSeq)) {
        this.dependencies.eventHub.publish(event);
      }
      this.projectWorkflowExperience(token.runId);
      if (status === "blocked" && action === "pause_for_approval") {
        const approval = ensureSettlementApproval(this.state.persistence.approvals, current, supervisorDecisionId, reason);
        this.dependencies.eventHub.publish(this.state.persistence.events.appendEvent(token.runId, "supervisor.approval.requested", { approvalId: approval.id, decisionId: supervisorDecisionId, reason }));
      }
      return action === "start_continuation" || action === "request_evidence" || action === "wait_for_runtime";
    } catch (error) {
      throw {
        kind: authoritativeSettlementRejected,
        message: error instanceof Error ? error.message : String(error),
        supervisorDecisionId,
      } satisfies AuthoritativeSettlementRejection;
    }
  }

  public recoverInterruptedAttempt(token: AttemptExecutionToken, reason: string, supervisorDecisionId?: string): boolean {
    try {
      const recovery = this.state.persistence.attempts.recoverInterruptedAttempt({
        attemptId: token.attemptId,
        expectedVersion: token.expectedVersion,
        ownerId: token.ownerId,
        leaseToken: token.leaseToken,
        fence: token.executionFence,
        reason,
        supervisorDecisionId,
      });
      if (recovery.event) this.dependencies.eventHub.publish(recovery.event);
      if (recovery.recovered) this.projectWorkflowExperience(token.runId);
      return recovery.recovered;
    } catch {
      // A newer Attempt or execution fence owns the Run. Stale callbacks are zero-write.
      return false;
    }
  }

  public isApprovedCanaryAttempt(token: AttemptExecutionToken): boolean {
    const authority = this.state.persistence.attemptAuthority.getAuthorityState();
    return authority.mode === "canary" && authority.status === "approved"
      && authority.approvedAttemptId === token.attemptId;
  }
}
