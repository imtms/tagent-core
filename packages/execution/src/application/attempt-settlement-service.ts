import { randomUUID } from "node:crypto";
import type { AttemptExecutionToken, AttemptRuntimePort } from "../ports/attempt-runtime.js";
import type { RunId } from "../domain/task-run.js";
import type { CandidateResult } from "../domain/index.js";
import type { ExecutionStateView } from "./execution-state.js";
import { ensureSettlementApproval } from "./settlement-approval.js";
import { executeRuntimePrompt } from "./runtime-skill.js";
import type {
  AttemptProjectionPort,
  RecoveryControlPort,
  RunEventPublisherPort,
  SupervisorPort,
} from "./collaboration-ports.js";

type AttemptSettlementState = ExecutionStateView<
  | "closing" | "continuationOwner" | "persistence",
  | "approvals" | "attempts" | "checkpoints"
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
  public projectWorkflowExperience(runId: RunId) { this.dependencies.projection.project(runId); }
  public async execute(runId: RunId, token: AttemptExecutionToken, runtime: AttemptRuntimePort, prompt: string, continuationId?: string, onRuntimeSettled: () => void = () => {}) {
    let candidateResponse = "";
    let candidate: CandidateResult | undefined;
    try {
      try {
        const contract = this.state.persistence.taskRuns.getRun(runId)?.contract;
        const skills = contract?.skills ?? [];
        await executeRuntimePrompt(runtime, prompt, skills.length === 1 ? skills[0].name : undefined);
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
      candidate = this.recordCandidate(token, response);
      const finalAssistant = assistantMessages.at(-1);
      const modelOutputTruncated = finalAssistant && "stopReason" in finalAssistant && finalAssistant.stopReason === "length";
      const checkpointSeq = this.state.persistence.checkpoints.getCheckpoint(runId)?.lastEventSeq ?? current.lastEventSeq;
      const review = await this.dependencies.supervisor.reviewSettled(current, checkpointSeq, response, { modelOutputTruncated });
      const decision = review.decision;
      const reviewedRun = this.state.persistence.taskRuns.getRun(runId);
      if (!reviewedRun || reviewedRun.status !== "running" || reviewedRun.attempt !== decision.attempt) {
        this.dependencies.supervisor.markExecuted(decision.id, "superseded");
        return false;
      }
      if (decision.action === "complete_taskrun") {
        return this.settleCandidate(token, candidate, decision.id, decision.action, "completed", "");
      }
      const reason = review.gates.find((gate) => gate.gateType === "completion")?.failures.map((failure) => `${failure.key}: ${failure.reason}`).join("; ") || decision.rationale;
      return this.settleCandidate(token, candidate, decision.id, decision.action, "blocked", reason);
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
          return this.settleCandidate(
            token,
            candidate,
            decision.id,
            decision.action,
            "blocked",
            "Supervisor review failed after bounded internal retries. The candidate result was preserved and the Agent was not rerun.",
          );
        } catch (settlementError) {
          if (isAuthoritativeSettlementRejection(settlementError)) {
            this.recoverInterruptedAttempt(token, settlementError.message, settlementError.supervisorDecisionId);
            return false;
          }
          throw settlementError;
        }
      }
      try {
        candidate ??= this.recordCandidate(token, candidateResponse);
      } catch (settlementError) {
        if (isAuthoritativeSettlementRejection(settlementError)) {
          this.recoverInterruptedAttempt(token, settlementError.message, settlementError.supervisorDecisionId);
          return false;
        }
        throw settlementError;
      }
      const decision = await this.dependencies.supervisor.reviewAttemptFailure(current, checkpointSeq, message);
      try {
        return this.settleCandidate(token, candidate, decision.id, decision.action, "blocked", message);
      } catch (settlementError) {
        if (isAuthoritativeSettlementRejection(settlementError)) {
          this.recoverInterruptedAttempt(token, settlementError.message, settlementError.supervisorDecisionId);
          return false;
        }
        throw settlementError;
      }
    }
  }

  private recordCandidate(token: AttemptExecutionToken, response: string): CandidateResult {
    try {
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

  private settleCandidate(
    token: AttemptExecutionToken, candidate: CandidateResult | undefined,
    supervisorDecisionId: string, action: string, status: "completed" | "blocked", reason: string,
  ): boolean {
    try {
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
      return action === "start_continuation" || action === "wait_for_runtime";
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

}
