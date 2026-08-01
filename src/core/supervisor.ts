import { createHash, randomUUID } from "node:crypto";
import type { Store } from "../store/store.js";
import type { CriterionCoverage, GateEvaluation, RunEvent, SupervisorDecision, SupervisorAction, TaskRun } from "./types.js";

export interface SupervisorPolicy {
  maxSteersPerAttempt: number;
  minEventsBetweenInterventions: number;
  repeatedFailureThreshold: number;
}

export interface SettledReview {
  decision: SupervisorDecision;
  gates: GateEvaluation[];
}

export class TaskRunSupervisor {
  constructor(private readonly store: Store, private readonly policy: SupervisorPolicy = { maxSteersPerAttempt: 2, minEventsBetweenInterventions: 3, repeatedFailureThreshold: 3 }) {}

  reviewCheckpoint(runId: string, event: RunEvent) {
    const run = this.store.getRun(runId);
    if (!run || run.status !== "running") return undefined;
    const snapshot = this.store.updateProgressSnapshot(run, event);
    if (!event.type.startsWith("tool.") && event.type !== "tool.guard.blocked") return undefined;
    const repeatedFailure = snapshot.consecutiveFailures >= this.policy.repeatedFailureThreshold;
    const repeatedOperation = snapshot.repeatedOperations >= this.policy.repeatedFailureThreshold;
    if (!repeatedFailure && !repeatedOperation) return undefined;
    const recent = this.store.listSupervisorDecisions(runId, run.attempt);
    const steers = recent.filter((item) => item.action === "steer" && (item.status === "proposed" || item.status === "executed"));
    if (steers.length >= this.policy.maxSteersPerAttempt) return undefined;
    const last = steers.at(-1);
    if (last && event.seq - last.checkpointSeq < this.policy.minEventsBetweenInterventions) return undefined;
    const reasonCode = repeatedFailure ? "repeated_tool_failures" : "repeated_tool_operation";
    const rationale = repeatedFailure
      ? `Stop repeating the failing operation. Inspect the root cause and use a materially different approach. ${snapshot.consecutiveFailures} consecutive tool failures were observed.`
      : `Stop repeating the same successful operation. ${snapshot.repeatedOperations} identical calls were observed without new TaskRun evidence; use the existing result or change approach.`;
    return this.createDecision(run, event.seq, "checkpoint", "steer", reasonCode, rationale, 1);
  }

  reviewSettled(run: TaskRun, checkpointSeq: number, response: string): SettledReview {
    const pendingControl = this.store.listControlInbox(run.id).filter((item) => item.attempt === run.attempt && ["queued", "delivering"].includes(item.status));
    if (pendingControl.length) {
      const gates = this.evaluateGates(run, checkpointSeq, response);
      for (const gate of gates) this.store.recordGateEvaluation(gate);
      return { gates, decision: this.createDecision(run, checkpointSeq, "settled", "wait_for_runtime", "pending_control_delivery", `${pendingControl.length} durable control message(s) are still pending delivery.`, 1, response) };
    }
    const gates = this.evaluateGates(run, checkpointSeq, response);
    for (const gate of gates) this.store.recordGateEvaluation(gate);
    const completion = gates.find((item) => item.gateType === "completion")!;
    let action: SupervisorAction;
    let reasonCode: string;
    let rationale: string;
    if (completion.passed) {
      action = "complete_taskrun";
      reasonCode = "all_gates_passed";
      rationale = "Required plan, verification, evidence, progress and delivery conditions passed.";
    } else {
      const failures = completion.failures;
      const needsApproval = failures.some((failure) => failure.disposition === "needs_approval");
      const needsInput = failures.some((failure) => failure.disposition === "needs_user_input" || failure.disposition === "external_dependency");
      const exhausted = failures.some((failure) => failure.disposition === "non_recoverable");
      const evidenceOnly = failures.length > 0 && failures.every((failure) => failure.kind === "evidence" && failure.disposition === "auto_fixable");
      if (needsApproval) {
        action = "pause_for_approval";
        reasonCode = "approval_required";
        rationale = failures.map((item) => item.reason).join("; ");
      } else if (needsInput || exhausted) {
        action = "block_taskrun";
        reasonCode = needsInput ? "human_or_external_dependency" : "continuation_not_viable";
        rationale = failures.map((item) => item.reason).join("; ");
      } else if (evidenceOnly) {
        action = "request_evidence";
        reasonCode = "verification_evidence_required";
        rationale = failures.map((item) => item.reason).join("; ");
      } else {
        action = "start_continuation";
        reasonCode = "auto_fixable_gate_failures";
        rationale = failures.map((item) => item.reason).join("; ");
      }
    }
    return { gates, decision: this.createDecision(run, checkpointSeq, "settled", action, reasonCode, rationale, 1, response) };
  }

  reviewAttemptFailure(run: TaskRun, checkpointSeq: number, error: string) {
    const normalized = error.toLowerCase();
    if (/(approval|permission|forbidden|policy|授权|审批|批准|权限)/i.test(error)) {
      return this.createDecision(run, checkpointSeq, "attempt_terminal", "pause_for_approval", "approval_required", error, 0.95);
    }
    if (/(credential|api key|token missing|user input|需要用户|缺少参数|请提供)/i.test(error)) {
      return this.createDecision(run, checkpointSeq, "attempt_terminal", "block_taskrun", "user_input_required", error, 0.92);
    }
    if (/(timeout|timed out|econnreset|econnrefused|socket hang up|network|rate limit|429|502|503|504|provider)/i.test(normalized)) {
      return this.createDecision(run, checkpointSeq, "attempt_terminal", "start_continuation", "transient_runtime_failure", error, 0.9);
    }
    return this.createDecision(run, checkpointSeq, "attempt_terminal", "block_taskrun", "runtime_failure", error, 0.8);
  }

  reviewSpawn(run: TaskRun, checkpointSeq: number) {
    const proposals = this.store.listSpawnProposals(run.id, "proposed");
    return proposals.map((proposal) => this.createDecision(run, checkpointSeq, "taskrun_terminal", "spawn_taskrun", "pending_explicit_proposal", `Spawn proposal ${proposal.id}: ${proposal.goal}`, 1));
  }

  markExecuted(id: string, status: "executed" | "superseded" | "failed", error = "") {
    return this.store.updateSupervisorDecision(id, status, error);
  }

  private evaluateGates(run: TaskRun, checkpointSeq: number, response: string): GateEvaluation[] {
    const createdAt = Date.now();
    const operations = this.store.listOperations(run.id);
    const manifest = { attempt: run.attempt, checkpointSeq, contract: run.contract, plan: run.plan, checks: run.checks, artifacts: run.artifacts.map(({ id, kind, uri }) => ({ id, kind, uri })), operations: operations.map(({ id, operationType, status, stage }) => ({ id, operationType, status, stage })), responseLength: response.length, usage: run.usage };
    const inputManifestHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    const gate = (gateType: GateEvaluation["gateType"], failures: GateEvaluation["failures"], criterionCoverage?: CriterionCoverage[]): GateEvaluation => ({ id: randomUUID(), runId: run.id, attempt: run.attempt, checkpointSeq, gateType, passed: failures.length === 0, failures, criterionCoverage, inputManifestHash, createdAt });
    const progressFailures: GateEvaluation["failures"] = [];
    const snapshot = this.store.getProgressSnapshot(run.id);
    if (snapshot?.attempt === run.attempt && snapshot.consecutiveFailures >= 6) progressFailures.push({ kind: "progress", key: "consecutive_failures", reason: `${snapshot.consecutiveFailures} consecutive tool failures`, disposition: "non_recoverable" });
    const evidenceFailures: GateEvaluation["failures"] = [];
    for (const check of run.checks.filter((item) => item.required && item.status === "passed")) {
      if (!check.evidence.trim()) evidenceFailures.push({ kind: "evidence", key: check.key, reason: "Required passed check has no evidence", disposition: "auto_fixable" });
      else if (!this.isIndependentCheckEvidence(check.command, check.evidence, run)) evidenceFailures.push({ kind: "evidence", key: check.key, reason: "Required check evidence is only an unverified assertion; provide a command, Operation receipt, or Artifact reference", disposition: "auto_fixable" });
      if (check.stale) evidenceFailures.push({ kind: "evidence", key: check.key, reason: "Required evidence is stale", disposition: "auto_fixable" });
    }
    const completionFailures: GateEvaluation["failures"] = [...progressFailures, ...evidenceFailures];
    if (run.gateRequired) {
      const requiredPlan = run.plan.filter((item) => item.required);
      if (!requiredPlan.length) completionFailures.push({ kind: "plan", key: "plan", reason: "No required plan items", disposition: "auto_fixable" });
      for (const item of requiredPlan) if (item.status !== "done") completionFailures.push({ kind: "plan_item", key: item.key, reason: `Required plan item is ${item.status}`, disposition: item.status === "blocked" ? /approval|permission|授权|审批|批准|权限/i.test(item.title) ? "needs_approval" : "needs_user_input" : item.status === "skipped" ? "non_recoverable" : "auto_fixable" });
      for (const check of run.checks.filter((item) => item.required)) if (check.status !== "passed") completionFailures.push({ kind: "check", key: check.key, reason: `Required check is ${check.status}`, disposition: check.status === "blocked" ? /approval|permission|授权|审批|批准|权限/i.test(check.title) ? "needs_approval" : "external_dependency" : check.status === "skipped" ? "non_recoverable" : "auto_fixable" });
    }
    if (!response.trim()) completionFailures.push({ kind: "delivery", key: "response", reason: "Candidate response is empty", disposition: "auto_fixable" });
    const criterionCoverage = this.evaluateContractCoverage(run, response);
    const contractFailures: GateEvaluation["failures"] = criterionCoverage.filter((item) => item.status === "unsupported" || item.status === "contradicted").map((item, index) => ({ kind: "contract", key: `criterion_${index + 1}`, reason: `${item.criterion}: ${item.reason}`, disposition: "auto_fixable" }));
    if (run.gateRequired && run.contract && contractFailures.length) completionFailures.push(...contractFailures);
    if (run.gateRequired && run.contract && !contractFailures.length && !this.isSubstantiveDelivery(response)) {
      completionFailures.push({ kind: "delivery", key: "contract_coverage", reason: "Candidate response is too short or generic to serve as the final TaskRun delivery", disposition: "auto_fixable" });
    }
    const claimFailures = this.validateCompletionClaims(run, response, operations);
    completionFailures.push(...claimFailures);
    return [gate("progress", progressFailures), gate("evidence", evidenceFailures), gate("contract", contractFailures, criterionCoverage), gate("completion", completionFailures, criterionCoverage), gate("continuation", completionFailures.filter((item) => item.disposition === "non_recoverable" || item.disposition === "needs_user_input" || item.disposition === "needs_approval" || item.disposition === "external_dependency"))];
  }


  private evaluateContractCoverage(run: TaskRun, response: string): CriterionCoverage[] {
    const criteria = run.contract?.acceptanceCriteria ?? [];
    const normalized = this.normalizeSemanticText(response);
    const evidenceRefs = [
      ...run.checks.filter((item) => item.status === "passed" && item.evidence.trim()).map((item) => `check:${item.key}`),
      ...run.artifacts.map((item) => `artifact:${item.id}`),
      ...this.store.listOperations(run.id).filter((item) => item.status === "succeeded").map((item) => `operation:${item.id}`),
    ];
    return criteria.map((criterion) => {
      const terms = this.semanticTerms(criterion);
      const covered = terms.length === 0 || terms.some((term) => normalized.includes(term)) || (/根因/.test(criterion) && /根因|原因|问题在于|because|caused by/i.test(response)) || (/验证|测试/.test(criterion) && /验证|测试|test|check|passed/i.test(response)) || (/修复|改进|实现/.test(criterion) && /修复|改进|增加|实现|fixed|implemented/i.test(response));
      const blocked = /(blocked|cannot|unable|waiting|requires|缺少|无法|不能|阻塞|等待|需要用户|需要审批)/i.test(response);
      return { criterion, status: covered ? "covered" : blocked ? "blocked" : "unsupported", evidenceRefs: covered ? evidenceRefs : [], reason: covered ? (evidenceRefs.length ? "Response coverage is backed by structured Run evidence." : "Response explicitly addresses this criterion.") : blocked ? "Response reports a concrete blocker." : "No criterion-specific result was found in the candidate response." };
    });
  }

  private validateCompletionClaims(run: TaskRun, response: string, operations: ReturnType<Store["listOperations"]>): GateEvaluation["failures"] {
    const claimsCompletion = /(已完成|完成了|已修复|已实现|已发布|已部署|测试通过|验证通过|passed|completed|fixed|implemented|released|deployed)/i.test(response);
    if (!claimsCompletion) return [];
    const verifiedCheck = run.checks.some((item) => item.required && item.status === "passed" && !item.stale && this.isIndependentCheckEvidence(item.command, item.evidence, run));
    const receipt = operations.some((item) => item.status === "succeeded");
    const artifact = run.artifacts.some((item) => Boolean(item.uri.trim() || item.content.trim()));
    if (verifiedCheck || receipt || artifact) return [];
    return [{ kind: "claim", key: "completion_evidence", reason: "Candidate claims completed, fixed, tested, deployed, or released work without an independent Check, Operation receipt, or Artifact", disposition: "auto_fixable" }];
  }

  private isIndependentCheckEvidence(command: string, evidence: string, run: TaskRun) {
    if (command.trim() && evidence.trim().length >= 8) return true;
    if (/\b(?:exit|status|http|sha|commit|tests?|passed|failed|build|lint)\b|通过|失败|状态码|提交|构建/i.test(evidence) && evidence.trim().length >= 20) return true;
    return run.artifacts.length > 0 || this.store.listOperations(run.id).some((item) => item.status === "succeeded");
  }

  private normalizeSemanticText(value: string) { return value.replace(/[()`*_>#{}:：,，.。!！?？/|+\-=]/g, " ").replaceAll("[", " ").replaceAll("]", " ").replace(/\s+/g, " ").trim().toLowerCase(); }
  private semanticTerms(value: string) {
    const normalized = this.normalizeSemanticText(value).replace(/^(?:交付目标结果|完成目标|提供|报告|给出|说明)/, "");
    const words = normalized.match(/[a-zA-Z][a-zA-Z0-9._/-]{2,}/g) ?? [];
    const han = normalized.match(/[\p{Script=Han}]{2,}/gu) ?? [];
    const fragments = han.flatMap((term) => term.length <= 4 ? [term] : Array.from({ length: term.length - 1 }, (_, index) => term.slice(index, index + 2)));
    return [...new Set([...words, ...fragments])].filter((term) => !/^(相关|提供|实际|结果|进行|当前|完成|目标)$/.test(term));
  }

  private isSubstantiveDelivery(response: string) {
    const normalized = this.normalizeSemanticText(response);
    if (/(blocked|cannot|unable|waiting|requires|缺少|无法|不能|阻塞|等待|需要用户|需要审批)/i.test(response)) return true;
    if (normalized.length < 80) return false;
    return !/^(?:收到|好的|明白|已处理|已经处理|任务完成|已完成|done|completed)[ 。.!！]*$/i.test(normalized);
  }

  private createDecision(run: TaskRun, checkpointSeq: number, trigger: SupervisorDecision["trigger"], action: SupervisorAction, reasonCode: string, rationale: string, confidence: number, candidateResponse = "") {
    const decision: SupervisorDecision = { id: randomUUID(), runId: run.id, attempt: run.attempt, checkpointSeq, trigger, action, reasonCode, rationale, confidence, instruction: action === "steer" || action === "follow_up" ? rationale : "", candidateResponseHash: createHash("sha256").update(candidateResponse).digest("hex"), status: "proposed", error: "", createdAt: Date.now(), executedAt: null };
    return this.store.recordSupervisorDecision(decision);
  }
}
