import { describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { Store } from "@tagent/persistence-sqlite/store";
import { TaskRunSupervisor, OpenAiSupervisorReviewer, TestSupervisorReviewer, passingTestAudit, type SupervisorAudit, type SupervisorReviewer } from "@tagent/core-service/composition";
import { createEnvironmentCredentialResolver, credentialReference } from "@tagent/execution/ports";
import { upsertTrustedCheck } from "./support/trusted-evidence.js";

const TEST_CREDENTIAL = {
  reference: credentialReference("TEST_API_KEY"),
  resolver: createEnvironmentCredentialResolver({ TEST_API_KEY: "secret" }),
};

function failingEvent(runId: string, seq: number) { return { runId, seq, type: "tool.completed", data: { toolName: "bash", isError: true }, createdAt: Date.now() }; }
function failedAudit(action: SupervisorAudit["action"], reasonCode: string, failure: { kind: string; key: string; reason: string; disposition: "auto_fixable" | "needs_user_input" | "needs_approval" | "external_dependency" | "runtime_transient" | "non_recoverable" }, criteria: string[] = []): SupervisorAudit {
  const coverage = criteria.map((criterion) => ({ criterion, status: "unsupported" as const, evidenceRefs: [], reason: failure.reason }));
  const gate = (failures = [failure], criterionCoverage = undefined as typeof coverage | undefined) => ({ passed: failures.length === 0, failures, criterionCoverage, summary: failures.length ? failure.reason : "Passed." });
  return { action, reasonCode, rationale: failure.reason, confidence: .97, gates: { progress: gate(failure.kind === "progress" ? [failure] : []), evidence: gate(failure.kind === "evidence" ? [failure] : []), contract: gate(failure.kind === "contract" ? [failure] : [], coverage), completion: gate([failure], coverage), continuation: gate(failure.disposition === "auto_fixable" ? [] : [failure]) } };
}
function semanticVerdict(options: {
  complete?: boolean;
  relevant?: boolean;
  contradictory?: boolean;
  reason?: string;
  criterionCoverage?: unknown[];
  goalCriterionCoverage?: unknown[];
  failures?: unknown[];
} = {}) {
  return {
    delivery: {
      complete: options.complete ?? true,
      relevant: options.relevant ?? true,
      contradictory: options.contradictory ?? false,
      reason: options.reason ?? "Complete.",
    },
    criterionCoverage: options.criterionCoverage ?? [],
    ...(options.goalCriterionCoverage ? { goalCriterionCoverage: options.goalCriterionCoverage } : {}),
    failures: (options.failures ?? []).map((failure) => ({ operationRefs: [], ...(failure as Record<string, unknown>) })),
  };
}

describe("TaskRunSupervisor LLM audit", () => {
  it("skips every Gate reviewer and emits no evaluations when Gate is off", async () => {
    const store = new Store(":memory:"); const session = store.createSession();
    const executionPolicy = { mode: "read_only_analysis", sideEffectRisk: "read_only", evidencePolicy: "operation_receipt", reviewPolicy: "full", gateProfile: "off", policyVersion: "test", confidence: 1, reason: "user selection" } as const;
    const contract = { sourceInput: "research", summary: "research", objectives: [{ id: "o1", summary: "research", timing: "current" as const, kind: "investigate" as const }], acceptanceCriteria: ["Deliver findings"], scope: "public sources", nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "new_task" as const, decisionReason: "test", routerVersion: "test", executionPolicy };
    const run = store.createRun(session.id, "research", "gate-off", contract);
    let calls = 0;
    const reviewer = { evaluator: "llm" as const, model: "must-not-run", async reviewSettled() { calls += 1; return passingTestAudit(); }, async reviewAttemptFailure() { throw new Error("unused"); } };
    const review = await new TaskRunSupervisor(store, reviewer).reviewSettled(run, 1, "Candidate result");
    expect(run.gateRequired).toBe(false);
    expect(calls).toBe(0);
    expect(review.gates).toEqual([]);
    expect(review.decision).toMatchObject({ action: "complete_taskrun", evaluator: "system", evaluatorModel: "gate-disabled-v1", reasonCode: "gate_disabled", epistemicStatus: "deterministic" });
    expect(store.getRun(run.id)?.supervision.latestGates).toEqual([]);
    store.close();
  });

  it("uses one relaxed review without plan/check prerequisites and tolerates unsupported secondary criteria", async () => {
    const store = new Store(":memory:"); const session = store.createSession();
    const executionPolicy = { mode: "read_only_analysis", sideEffectRisk: "read_only", evidencePolicy: "operation_receipt", reviewPolicy: "full", gateProfile: "relaxed", policyVersion: "test", confidence: 1, reason: "user selection" } as const;
    const criteria = ["Deliver core findings", "Estimate an uncertain secondary metric"];
    const contract = { sourceInput: "research", summary: "research", objectives: [{ id: "o1", summary: "research", timing: "current" as const, kind: "investigate" as const }], acceptanceCriteria: criteria, scope: "public sources", nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "new_task" as const, decisionReason: "test", routerVersion: "test", executionPolicy };
    const run = store.createRun(session.id, "research", "gate-relaxed", contract);
    let relaxedCalls = 0; let fullCalls = 0;
    const coverage = [
      { criterion: criteria[0], status: "covered" as const, evidenceRefs: [], reason: "Core findings are present." },
      { criterion: criteria[1], status: "unsupported" as const, evidenceRefs: [], reason: "The public sample cannot support a precise estimate." },
    ];
    const reviewer = {
      evaluator: "llm" as const, model: "relaxed-test",
      async reviewSettled() { fullCalls += 1; return passingTestAudit(); },
      async reviewRelaxed() { relaxedCalls += 1; return { ...passingTestAudit(), evaluatorModel: "relaxed-test", gates: { ...passingTestAudit().gates, contract: { passed: true, failures: [], summary: "Core outcome delivered.", criterionCoverage: coverage } } }; },
      async reviewAttemptFailure() { throw new Error("unused"); },
    };
    const current = store.getRun(run.id)!;
    expect(current.completionGate.passed).toBe(true);
    const review = await new TaskRunSupervisor(store, reviewer).reviewSettled(current, 1, "Core findings with explicit uncertainty.");
    expect(relaxedCalls).toBe(1); expect(fullCalls).toBe(0);
    expect(review.decision.action).toBe("complete_taskrun");
    expect(review.gates.find((gate) => gate.gateType === "contract")).toMatchObject({ passed: true, criterionCoverage: coverage });
    store.close();
  });

  it("keeps deterministic checkpoint loop protection while completion quality is LLM-reviewed", () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "recover");
    const supervisor = new TaskRunSupervisor(store, new TestSupervisorReviewer(), { repeatedFailureThreshold: 3, maxSteersPerAttempt: 1, minEventsBetweenInterventions: 1 });
    expect(supervisor.reviewCheckpoint(run.id, failingEvent(run.id, 1))).toBeUndefined();
    expect(supervisor.reviewCheckpoint(run.id, failingEvent(run.id, 2))).toBeUndefined();
    expect(supervisor.reviewCheckpoint(run.id, failingEvent(run.id, 3))).toMatchObject({ action: "steer", evaluator: "system" });
    store.close();
  });

  it("persists the LLM evaluator, model, summaries, failures, and criterion receipts", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "audit contract");
    const criterion = "交付准确的实现和验证证据";
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify({ sourceInput: run.goal, summary: run.goal, objectives: [], acceptanceCriteria: [criterion], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "new_task", decisionReason: "test", routerVersion: "test" }), run.id);
    store.upsertPlanItem(run.id, { key: "audit", title: "Audit contract", status: "done", required: true, position: 1 });
    const audit = failedAudit("start_continuation", "contract_not_satisfied", { kind: "contract", key: "criterion_1", reason: "The result is unsupported by the candidate response.", disposition: "auto_fixable" }, [criterion]);
    const review = await new TaskRunSupervisor(store, new TestSupervisorReviewer(audit)).reviewSettled(store.getRun(run.id)!, 9, "generic answer");
    expect(review.decision).toMatchObject({ action: "start_continuation", evaluator: "llm", evaluatorModel: "test-supervisor-llm" });
    expect(store.getRun(run.id)?.supervision.latestGates.find((gate) => gate.gateType === "contract")).toMatchObject({ evaluator: "llm", evaluatorModel: "test-supervisor-llm", summary: expect.any(String), criterionCoverage: [{ criterion, status: "unsupported", evidenceRefs: [], reason: expect.any(String) }] });
    store.close();
  });

  it("completes with active accepted uncertainty but never exempts contradicted coverage", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "qualify the unavailable result");
    const criterion = "Report the upstream result or its irreducible unavailability";
    store.db.prepare("UPDATE runs SET contract_json=? WHERE id=?").run(JSON.stringify({ sourceInput: run.goal, summary: run.goal, objectives: [], acceptanceCriteria: [criterion], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "new_task", decisionReason: "test", routerVersion: "test" }), run.id);
    store.upsertPlanItem(run.id, { key: "qualify", title: "Qualify result", status: "done", required: true, position: 1 });
    const accepted = store.acceptUncertainty({ id: "uncertainty-1", runId: run.id, criterionId: "ac-1", actorId: "operator:test", rationale: "The upstream remained unavailable after bounded recovery.", scope: "This TaskRun only.", evidenceRefs: [], expiresAt: null, createdAt: Date.now() });
    const unsupported = failedAudit("start_continuation", "unsupported", { kind: "contract", key: "acceptance_criterion_1", reason: "The upstream is unavailable.", disposition: "external_dependency" }, [criterion]);
    const completed = await new TaskRunSupervisor(store, new TestSupervisorReviewer(unsupported)).reviewSettled(store.getRun(run.id)!, 4, "The upstream limitation is documented.");
    expect(completed.decision.action).toBe("complete_taskrun");
    expect(completed.gates.find((gate) => gate.gateType === "contract")).toMatchObject({
      passed: true, failures: [], criterionCoverage: [{ status: "unsupported", acceptedUncertaintyId: accepted.id }],
    });

    const independentEvidenceFailure = {
      ...unsupported,
      gates: {
        ...unsupported.gates,
        evidence: {
          passed: false,
          failures: [{
            kind: "evidence", key: "ac-1", reason: "The independently required evidence is missing.",
            disposition: "auto_fixable" as const,
          }],
          criterionCoverage: [{
            criterion: "Observe the cumulative Goal result", status: "blocked" as const,
            evidenceRefs: [], reason: "The Goal observation is not available yet.",
          }],
          summary: "Required evidence is missing.",
        },
      },
    };
    const evidenceBlocked = await new TaskRunSupervisor(store, new TestSupervisorReviewer(independentEvidenceFailure))
      .reviewSettled(store.getRun(run.id)!, 5, "The upstream limitation is documented.");
    expect(evidenceBlocked.decision.action).toBe("start_continuation");
    expect(evidenceBlocked.gates.find((gate) => gate.gateType === "evidence")).toMatchObject({
      passed: false,
      failures: [{ kind: "evidence", key: "ac-1" }],
      criterionCoverage: [{ status: "blocked" }],
    });
    expect(evidenceBlocked.gates.find((gate) => gate.gateType === "evidence")?.criterionCoverage?.[0])
      .not.toHaveProperty("acceptedUncertaintyId");

    const contradicted = failedAudit("start_continuation", "contradicted", { kind: "contract", key: "acceptance_criterion_1", reason: "The candidate contradicts durable evidence.", disposition: "auto_fixable" }, [criterion]);
    contradicted.gates.contract.criterionCoverage![0]!.status = "contradicted";
    contradicted.gates.completion.criterionCoverage![0]!.status = "contradicted";
    const rejected = await new TaskRunSupervisor(store, new TestSupervisorReviewer(contradicted)).reviewSettled(store.getRun(run.id)!, 5, "A contradictory claim.");
    expect(rejected.decision.action).toBe("start_continuation");
    expect(rejected.gates.find((gate) => gate.gateType === "contract")).toMatchObject({ passed: false, criterionCoverage: [{ status: "contradicted" }] });
    store.close();
  });

  it("skips the LLM when authoritative plan prerequisites already fail", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "incomplete plan");
    store.upsertPlanItem(run.id, { key: "implement", title: "Implement", status: "pending", required: true, position: 1 });
    let calls = 0;
    const reviewer = {
      evaluator: "llm" as const, model: "must-not-run",
      async reviewSettled() { calls += 1; return passingTestAudit(); },
      async reviewAttemptFailure() { return { action: "block_taskrun" as const, reasonCode: "unused", rationale: "unused", confidence: 1 }; },
    };
    const startedAt = performance.now();
    const review = await new TaskRunSupervisor(store, reviewer).reviewSettled(store.getRun(run.id)!, 4, "done");
    const latencyMs = performance.now() - startedAt;
    expect(calls).toBe(0);
    expect(latencyMs).toBeLessThan(100);
    expect(review.decision).toMatchObject({ action: "start_continuation", evaluator: "system", evaluatorModel: "deterministic-prerequisite-gate", reasonCode: "deterministic_plan_incomplete" });
    expect(review.gates.find((gate) => gate.gateType === "completion")).toMatchObject({ passed: false, evaluator: "system" });
    expect(review.gates.find((gate) => gate.gateType === "contract")).toMatchObject({ passed: true, failures: [], criterionCoverage: undefined });
    store.close();
  });

  it("skips the LLM and starts a continuation when only required checks fail", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "missing check evidence");
    const contract = { sourceInput: run.goal, summary: run.goal, objectives: [{ id: "objective-1", summary: run.goal, timing: "current" as const, kind: "change" as const }], acceptanceCriteria: ["Verification evidence is current"], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "new_task" as const, decisionReason: "test", routerVersion: "test" };
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify(contract), run.id);
    store.upsertPlanItem(run.id, { key: "implement", title: "Implement", status: "done", required: true, position: 1 });
    store.upsertCheck(run.id, { key: "verify", title: "Verify", status: "passed", required: true, command: "npm test", evidence: "old", stale: true });
    let calls = 0;
    const reviewer = {
      evaluator: "llm" as const, model: "must-not-run",
      async reviewSettled() { calls += 1; return passingTestAudit(); },
      async reviewAttemptFailure() { return { action: "block_taskrun" as const, reasonCode: "unused", rationale: "unused", confidence: 1 }; },
    };
    const review = await new TaskRunSupervisor(store, reviewer).reviewSettled(store.getRun(run.id)!, 5, "done");
    expect(calls).toBe(0);
    expect(review.decision).toMatchObject({ action: "start_continuation", evaluator: "system", reasonCode: "deterministic_check_incomplete" });
    expect(review.gates.find((gate) => gate.gateType === "evidence")?.failures[0]).toMatchObject({ key: "verify", disposition: "auto_fixable" });
    expect(review.gates.find((gate) => gate.gateType === "contract")).toMatchObject({
      passed: false,
      failures: [],
      criterionCoverage: undefined,
      summary: expect.stringContaining("Not evaluated yet"),
    });
    expect(review.gates.find((gate) => gate.gateType === "completion")?.failures).toEqual([
      expect.objectContaining({ key: "verify", kind: "check" }),
    ]);
    store.close();
  });

  it("uses semantic-lite review for a low-risk single-answer discussion", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "explain caching");
    const contract = { sourceInput: run.goal, summary: run.goal, objectives: [{ id: "objective-1", summary: run.goal, timing: "current" as const, kind: "answer" as const }], acceptanceCriteria: ["Explain caching clearly"], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "discussion" as const, decisionReason: "test", routerVersion: "test" };
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify(contract), run.id);
    let calls = 0;
    const reviewer = {
      evaluator: "llm" as const, model: "must-not-run",
      async reviewSettled() { calls += 1; return passingTestAudit(); },
      async reviewSemanticLite() { calls += 1; return { ...passingTestAudit(), evaluatorModel: "semantic-lite-test", gates: { ...passingTestAudit().gates, contract: { passed: true, failures: [], summary: "Covered semantically.", criterionCoverage: [{ criterion: "Explain caching clearly", status: "covered" as const, evidenceRefs: [], reason: "The response explains caching." }] } } }; },
      async reviewAttemptFailure() { return { action: "block_taskrun" as const, reasonCode: "unused", rationale: "unused", confidence: 1 }; },
    };
    const current = store.getRun(run.id)!;
    expect(current.completionGate.passed).toBe(true);
    const review = await new TaskRunSupervisor(store, reviewer).reviewSettled(current, 2, "Caching stores reusable results so repeated work completes faster.");
    expect(calls).toBe(1);
    expect(review.decision).toMatchObject({ action: "complete_taskrun", evaluator: "llm", evaluatorModel: "semantic-lite-test" });
    expect(review.gates.find((gate) => gate.gateType === "contract")?.criterionCoverage).toEqual([expect.objectContaining({ criterion: "Explain caching clearly", status: "covered" })]);
    store.close();
  });

  it("locally completes only an exact literal delivery and repairs a mismatch", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "only reply OK");
    const executionPolicy = { mode: "exact_delivery", sideEffectRisk: "none", evidencePolicy: "none", reviewPolicy: "local", exactOutput: "OK", policyVersion: "test", confidence: 1, reason: "literal" } as const;
    const contract = { sourceInput: run.goal, summary: run.goal, objectives: [{ id: "objective-1", summary: run.goal, timing: "current" as const, kind: "other" as const }], acceptanceCriteria: ["Return OK"], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "new_task" as const, decisionReason: "test", routerVersion: "test", executionPolicy };
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify(contract), run.id);
    let calls = 0;
    const reviewer = { evaluator: "llm" as const, model: "must-not-run", async reviewSettled() { calls += 1; return passingTestAudit(); }, async reviewAttemptFailure() { return { action: "block_taskrun" as const, reasonCode: "unused", rationale: "unused", confidence: 1 }; } };
    const supervisor = new TaskRunSupervisor(store, reviewer);
    expect((await supervisor.reviewSettled(store.getRun(run.id)!, 1, "OK")).decision).toMatchObject({ action: "complete_taskrun", evaluatorModel: "deterministic-exact-delivery-v1" });
    expect((await supervisor.reviewSettled(store.getRun(run.id)!, 2, "Okay")).decision).toMatchObject({ action: "start_continuation", reasonCode: "exact_delivery_mismatch" });
    expect(calls).toBe(0); store.close();
  });

  it("does not use exact local validation for an inconsistent persisted semantic policy", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "only reply OK");
    const executionPolicy = { mode: "exact_delivery", sideEffectRisk: "none", evidencePolicy: "semantic", reviewPolicy: "local", exactOutput: "OK", policyVersion: "inconsistent-test", confidence: 1, reason: "inconsistent" } as const;
    const contract = { sourceInput: run.goal, summary: run.goal, objectives: [{ id: "objective-1", summary: run.goal, timing: "current" as const, kind: "other" as const }], acceptanceCriteria: ["Return OK"], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "new_task" as const, decisionReason: "test", routerVersion: "test", executionPolicy };
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify(contract), run.id);
    let semanticCalls = 0;
    const reviewer = {
      evaluator: "llm" as const, model: "semantic-lite-test",
      async reviewSettled() { throw new Error("full review must not run"); },
      async reviewSemanticLite() { semanticCalls += 1; return { ...passingTestAudit(), evaluatorModel: "semantic-lite-test", gates: { ...passingTestAudit().gates, contract: { passed: true, failures: [], summary: "Covered.", criterionCoverage: [{ criterion: "Return OK", status: "covered" as const, evidenceRefs: [], reason: "Covered semantically." }] } } }; },
      async reviewAttemptFailure() { return { action: "block_taskrun" as const, reasonCode: "unused", rationale: "unused", confidence: 1 }; },
    };
    const review = await new TaskRunSupervisor(store, reviewer).reviewSettled(store.getRun(run.id)!, 1, "OK");
    expect(semanticCalls).toBe(1);
    expect(review.decision).toMatchObject({ action: "complete_taskrun", evaluatorModel: "semantic-lite-test" }); store.close();
  });

  it("rejects an irrelevant semantic-lite candidate instead of inferring coverage from length", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "explain caching");
    const executionPolicy = { mode: "semantic_delivery", sideEffectRisk: "none", evidencePolicy: "semantic", reviewPolicy: "semantic_lite", policyVersion: "test", confidence: 1, reason: "answer" } as const;
    const contract = { sourceInput: run.goal, summary: run.goal, objectives: [{ id: "objective-1", summary: run.goal, timing: "current" as const, kind: "answer" as const }], acceptanceCriteria: ["Explain caching"], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "discussion" as const, decisionReason: "test", routerVersion: "test", executionPolicy };
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify(contract), run.id);
    const failure = { kind: "completion", key: "delivery_irrelevant", reason: "The answer discusses weather.", disposition: "auto_fixable" as const };
    const failed = failedAudit("start_continuation", "semantic_lite_repair_required", failure, contract.acceptanceCriteria);
    const reviewer = new TestSupervisorReviewer(failed) as TestSupervisorReviewer & { reviewSemanticLite: TestSupervisorReviewer["reviewSettled"] };
    reviewer.reviewSemanticLite = reviewer.reviewSettled.bind(reviewer);
    const review = await new TaskRunSupervisor(store, reviewer).reviewSettled(store.getRun(run.id)!, 1, "The weather is pleasant today and the park is open.");
    expect(review.decision.action).toBe("start_continuation");
    expect(review.gates.find((gate) => gate.gateType === "contract")?.passed).toBe(false); store.close();
  });

  it("accepts the documented semantic-lite receipt schema with empty evidence refs", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "translate greeting");
    const executionPolicy = { mode: "semantic_delivery", sideEffectRisk: "none", evidencePolicy: "semantic", reviewPolicy: "semantic_lite", policyVersion: "test", confidence: 1, reason: "translation" } as const;
    const contract = { sourceInput: run.goal, summary: run.goal, objectives: [{ id: "objective-1", summary: run.goal, timing: "current" as const, kind: "other" as const }], acceptanceCriteria: ["Preserve the greeting"], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "new_task" as const, decisionReason: "test", routerVersion: "test", executionPolicy };
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify(contract), run.id);
    let prompt = "";
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      prompt = (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[0].content;
      const content = { delivery: { complete: true, relevant: true, contradictory: false, reason: "The translation preserves the greeting." }, criterionCoverage: [{ criterionId: "ac-1", status: "covered", evidenceRefs: [], reason: "Meaning is preserved." }] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
    };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSemanticLite({ run: store.getRun(run.id)!, response: "Hello.", operations: [], progress: undefined });
      expect(prompt).toContain('"evidenceRefs":[]');
      expect(audit).toMatchObject({ action: "complete_taskrun", gates: { contract: { passed: true }, completion: { passed: true } } });
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("escalates lightweight-looking discussions when delivery risk is present", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "explain production release");
    const contract = { sourceInput: run.goal, summary: run.goal, objectives: [{ id: "objective-1", summary: run.goal, timing: "current" as const, kind: "answer" as const }], acceptanceCriteria: ["Explain release"], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "discussion" as const, decisionReason: "test", routerVersion: "test" };
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify(contract), run.id);
    let calls = 0;
    const reviewer = {
      evaluator: "llm" as const, model: "semantic-model",
      async reviewSettled() { calls += 1; return passingTestAudit(); },
      async reviewAttemptFailure() { return { action: "block_taskrun" as const, reasonCode: "unused", rationale: "unused", confidence: 1 }; },
    };
    const review = await new TaskRunSupervisor(store, reviewer).reviewSettled(store.getRun(run.id)!, 2, "A production release changes externally visible software and requires care.");
    expect(calls).toBe(1);
    expect(review.decision).toMatchObject({ evaluator: "llm", evaluatorModel: "semantic-model" });
    store.close();
  });

  it("still invokes semantic LLM review after deterministic prerequisites pass", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "semantic audit required");
    store.upsertPlanItem(run.id, { key: "implement", title: "Implement", status: "done", required: true, position: 1 });
    upsertTrustedCheck(store, run.id, { key: "verify", title: "Verify", command: "npm test", output: "fresh pass" });
    let calls = 0;
    const reviewer = {
      evaluator: "llm" as const, model: "semantic-model",
      async reviewSettled() { calls += 1; return passingTestAudit(); },
      async reviewAttemptFailure() { return { action: "block_taskrun" as const, reasonCode: "unused", rationale: "unused", confidence: 1 }; },
    };
    const review = await new TaskRunSupervisor(store, reviewer).reviewSettled(store.getRun(run.id)!, 6, "standalone result");
    expect(calls).toBe(1);
    expect(review.decision).toMatchObject({ action: "complete_taskrun", evaluator: "llm", evaluatorModel: "semantic-model" });
    store.close();
  });

  it("forces unsupported criterion coverage closed even when the LLM claims completion", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "authoritative coverage");
    const criterion = "Explain the verified result";
    store.db.prepare("UPDATE runs SET contract_json=? WHERE id=?").run(JSON.stringify({ sourceInput: run.goal, summary: run.goal, objectives: [], acceptanceCriteria: [criterion], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "new_task", decisionReason: "test", routerVersion: "test" }), run.id);
    store.upsertPlanItem(run.id, { key: "answer", title: "Answer", status: "done", required: true, position: 1 });
    const inconsistent = passingTestAudit();
    inconsistent.gates.contract.criterionCoverage = [{ criterion, status: "unsupported", evidenceRefs: [], reason: "The candidate does not substantiate the result." }];
    const review = await new TaskRunSupervisor(store, new TestSupervisorReviewer(inconsistent)).reviewSettled(store.getRun(run.id)!, 3, "unsupported claim");
    expect(review.decision).toMatchObject({ action: "start_continuation", reasonCode: "authoritative_start_continuation" });
    expect(review.gates.find((gate) => gate.gateType === "contract")).toMatchObject({ passed: false, failures: [expect.objectContaining({ kind: "contract" })] });
    expect(review.gates.find((gate) => gate.gateType === "completion")?.passed).toBe(false);
    store.close();
  });

  it("fails closed when a Gate reports failure without an auditable reason", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "fail closed");
    const inconsistent = passingTestAudit();
    inconsistent.gates.progress.passed = false;
    inconsistent.gates.completion.passed = false;
    const review = await new TaskRunSupervisor(store, new TestSupervisorReviewer(inconsistent))
      .reviewSettled(run, 3, "unsupported completion");
    expect(review.decision).toMatchObject({ action: "block_taskrun", reasonCode: "authoritative_block_taskrun" });
    expect(review.gates.find((gate) => gate.gateType === "completion")).toMatchObject({
      passed: false,
      failures: [expect.objectContaining({
        kind: "supervisor", key: "inconsistent_gate_state", disposition: "non_recoverable",
      })],
    });
    store.close();
  });

  it("accepts completion only when the structured LLM completion gate passes", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "complete");
    const review = await new TaskRunSupervisor(store, new TestSupervisorReviewer(passingTestAudit())).reviewSettled(run, 4, "standalone result");
    expect(review.decision).toMatchObject({ action: "complete_taskrun", reasonCode: "all_gates_passed", evaluator: "llm" });
    expect(review.gates.every((gate) => gate.passed)).toBe(true); store.close();
  });

  it("continues when the LLM reports missing evidence", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "evidence");
    const audit = failedAudit("start_continuation", "verification_evidence_required", { kind: "evidence", key: "test", reason: "Fresh independent evidence is missing.", disposition: "auto_fixable" });
    const review = await new TaskRunSupervisor(store, new TestSupervisorReviewer(audit)).reviewSettled(run, 5, "result");
    expect(review.decision.action).toBe("start_continuation"); expect(review.gates.find((gate) => gate.gateType === "evidence")?.passed).toBe(false); store.close();
  });

  it("maps LLM approval findings to an explicit approval pause", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "deploy");
    const audit = failedAudit("pause_for_approval", "approval_required", { kind: "approval", key: "production", reason: "Production approval is required.", disposition: "needs_approval" });
    const review = await new TaskRunSupervisor(store, new TestSupervisorReviewer(audit)).reviewSettled(run, 5, "waiting");
    expect(review.decision).toMatchObject({ action: "pause_for_approval", evaluator: "llm" }); store.close();
  });

  it("uses LLM classification for terminal runtime failures", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "provider retry");
    const reviewer = new TestSupervisorReviewer(passingTestAudit(), { action: "start_continuation", reasonCode: "transient_runtime_failure", rationale: "Provider outage is transient.", confidence: .94 });
    const decision = await new TaskRunSupervisor(store, reviewer).reviewAttemptFailure(run, 7, "opaque provider error");
    expect(decision).toMatchObject({ action: "start_continuation", reasonCode: "transient_runtime_failure", evaluator: "llm" }); store.close();
  });

  it("classifies known runtime failures locally without an LLM call", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "known provider failure");
    let calls = 0;
    const reviewer = {
      evaluator: "llm" as const, model: "must-not-run",
      async reviewSettled() { return passingTestAudit(); },
      async reviewAttemptFailure() { calls += 1; throw new Error("must not run"); },
    };
    const supervisor = new TaskRunSupervisor(store, reviewer);
    const decision = await supervisor.reviewAttemptFailure(run, 7, "HTTP 429 rate limit exceeded");
    const cooldown = await supervisor.reviewAttemptFailure(run, 8, '{"type":"model_cooldown","reset_seconds":47}');
    expect(calls).toBe(0);
    expect(decision).toMatchObject({ action: "start_continuation", reasonCode: "runtime_transient_failure", evaluator: "system", evaluatorModel: "deterministic-runtime-failure-v1" });
    expect(cooldown).toMatchObject({ action: "start_continuation", reasonCode: "runtime_transient_failure", evaluator: "system" });
    store.close();
  });

  it("sends actual Bash output to the LLM and keeps semantically contradictory evidence closed", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "verify the implementation");
    const criterion = "The full test suite passes";
    const contract = { sourceInput: run.goal, summary: run.goal, objectives: [{ id: "change-1", summary: run.goal, timing: "current" as const, kind: "change" as const }], acceptanceCriteria: [criterion], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "new_task" as const, decisionReason: "test", routerVersion: "test" };
    store.db.prepare("UPDATE runs SET contract_json=? WHERE id=?").run(JSON.stringify(contract), run.id);
    store.upsertPlanItem(run.id, { key: "implement", title: "Implement", status: "done", required: true, position: 1 });
    const operation = upsertTrustedCheck(store, run.id, { key: "tests", title: "Tests", command: "npm test", output: "FAIL 1 test, PASS 20 tests" });
    expect(store.getRun(run.id)?.completionGate.passed).toBe(true);
    const failure = { kind: "evidence", key: "tests", reason: "The actual receipt reports a failing test.", disposition: "auto_fixable" };
    const payload = semanticVerdict({
      contradictory: true,
      reason: "The receipt contradicts the completion claim.",
      criterionCoverage: [{ criterionId: "ac-1", status: "contradicted", evidenceRefs: [`check:tests`, `operation:${operation.id}`], reason: "The actual output contains a failing test." }],
      failures: [failure],
    });
    let prompt = "";
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      prompt = (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[0].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });
    };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run: store.getRun(run.id)!, response: "Everything passed.", operations: store.listOperations(run.id), progress: undefined });
      expect(prompt).toContain("FAIL 1 test");
      expect(prompt).toContain('"trusted":true');
      expect(prompt).toContain(operation.id);
      expect(audit).toMatchObject({ action: "start_continuation", gates: { evidence: { passed: false }, contract: { passed: false }, completion: { passed: false } } });
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("observes mapped Goal criteria without making them Roadmap-item completion gates", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "complete stage one");
    const goalPrompt = "[Workspace Goal criterion rollout_complete] The complete rollout is verified";
    const contract = {
      sourceInput: run.goal, summary: run.goal,
      objectives: [{ id: "stage-one", summary: "Foundation is ready", timing: "current" as const, kind: "change" as const }],
      // Simulate a pre-fix immutable contract that already persisted the Goal
      // prompt as a third TaskRun acceptance criterion.
      acceptanceCriteria: ["Foundation is ready", "Foundation tests pass", goalPrompt], scope: "foundation", nonGoals: [], sourceInboxIds: [],
      parentRunId: null, relation: "independent" as const, intent: "new_task" as const, decisionReason: "test", routerVersion: "workspace-goal-roadmap-v1",
      workspaceGoal: {
        goalId: "goal-1", mode: "roadmap" as const, definitionRevisionId: "definition-1", definitionRevision: 1, definitionHash: "definition-hash",
        title: "Roll out the feature", outcome: "The complete feature is rolled out", scope: ["foundation", "integration"], nonGoals: [],
        criteria: [{ key: "rollout_complete", title: "The complete rollout is verified", required: true }],
        roadmapRevisionId: "roadmap-1", roadmapRevision: 1, roadmapHash: "roadmap-hash", approvedRoadmapItemIds: ["foundation", "integration"],
        targetRoadmapItemIds: ["foundation"], roadmapItems: [{ id: "foundation", title: "Build foundation", outcome: "Foundation is ready", verification: "Foundation tests pass", criterionKeys: ["rollout_complete"] }],
        targetCriterionKeys: ["rollout_complete"], criterionPrompts: [{ key: "rollout_complete", prompt: goalPrompt }], attachedAt: Date.now(),
      },
    };
    store.db.prepare("UPDATE runs SET contract_json=? WHERE id=?").run(JSON.stringify(contract), run.id);
    const verification = upsertTrustedCheck(store, run.id, { key: "foundation", title: "Foundation tests", command: "npm test -- foundation", output: "foundation passed" });
    const verificationSource = store.resolveEvidenceSources(run.id, [`operation:${verification.id}`])[0]!;
    const verificationQuote = { sourceRef: verificationSource.sourceRef, sourceRevision: verificationSource.sourceRevision, sourceHash: verificationSource.sourceHash, selector: { kind: "text_quote", exact: "foundation passed" }, quote: "foundation passed" };
    const payload = semanticVerdict({
      criterionCoverage: [
        { criterionId: "ac-1", status: "covered", evidenceRefs: ["check:foundation", verificationSource.sourceRef], evidenceQuotes: [verificationQuote], reason: "The foundation is present." },
        { criterionId: "ac-2", status: "covered", evidenceRefs: ["check:foundation", verificationSource.sourceRef], evidenceQuotes: [verificationQuote], reason: "The foundation verification passed." },
      ],
      goalCriterionCoverage: [{ criterionId: "gc-1", status: "unsupported", evidenceRefs: [], reason: "Integration belongs to a later Roadmap item." }],
      failures: [{ kind: "contract", key: "gc-1", reason: "The complete rollout is not finished yet.", disposition: "auto_fixable" }],
    });
    let prompt = "";
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      prompt = (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[0].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });
    };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({
        run: store.getRun(run.id)!, response: "Stage one is complete and verified.", operations: store.listOperations(run.id), progress: undefined,
        evidenceSources: [verificationSource],
      });
      expect(prompt).toContain('"goalCriteriaForEvidence":[{"criterionId":"gc-1"');
      expect(prompt).toContain("not acceptance criteria for this bounded TaskRun");
      expect(prompt).toContain(verification.id);
      expect(audit).toMatchObject({
        action: "complete_taskrun",
        gates: {
          evidence: { passed: true, criterionCoverage: [{ criterion: goalPrompt, status: "unsupported" }] },
          contract: { passed: true, criterionCoverage: [{ criterion: "Foundation is ready", status: "covered" }, { criterion: "Foundation tests pass", status: "covered" }] },
          completion: { passed: true },
        },
      });
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("treats recovered prior-Attempt failures as audit context instead of current progress blockers", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "repair and verify the migration");
    const criterion = "The repaired migration passes its final verification";
    store.db.prepare("UPDATE runs SET contract_json=? WHERE id=?").run(JSON.stringify({
      sourceInput: run.goal, summary: run.goal,
      objectives: [{ id: "change-1", summary: run.goal, timing: "current", kind: "change" }],
      acceptanceCriteria: [criterion], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null,
      relation: "independent", intent: "new_task", decisionReason: "test", routerVersion: "test",
    }), run.id);
    store.claimOperation("prior-failure", run.id, 1, "tool.bash", { command: "npm run migrate" });
    const priorFailure = store.updateOperation("prior-failure", {
      status: "failed", stage: "execution_failed", error: "migration failed before the repair",
      result: { content: [{ type: "text", text: "migration failed" }], details: { exitCode: 1 } },
    });
    store.db.prepare("UPDATE runs SET attempt=2 WHERE id=?").run(run.id);
    const verification = upsertTrustedCheck(store, run.id, {
      key: "verify", title: "Verify repaired migration", command: "npm test", output: "migration and regression tests passed",
    });
    const verificationSource = store.resolveEvidenceSources(run.id, [`operation:${verification.id}`])[0]!;
    const verdict = semanticVerdict({
      criterionCoverage: [{ criterionId: "ac-1", status: "covered", evidenceRefs: ["check:verify", verificationSource.sourceRef], evidenceQuotes: [{ sourceRef: verificationSource.sourceRef, sourceRevision: verificationSource.sourceRevision, sourceHash: verificationSource.sourceHash, selector: { kind: "text_quote", exact: "migration and regression tests passed" }, quote: "migration and regression tests passed" }], reason: "The current verification covers the repaired final state." }],
      failures: [{
        kind: "progress", key: "historical_migration_failure", reason: "Attempt 1 contained a failed migration.",
        disposition: "auto_fixable", operationRefs: [`operation:${priorFailure.id}`],
      }],
    });
    let prompt = "";
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      prompt = (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[0].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }), { status: 200 });
    };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({
        run: store.getRun(run.id)!, response: "The migration was repaired and the current verification passed.",
        operations: store.listOperations(run.id), progress: undefined, evidenceSources: [verificationSource],
      });
      expect(audit).toMatchObject({
        action: "complete_taskrun", reasonCode: "non_current_progress_ignored",
        gates: { progress: { passed: true, failures: [] }, completion: { passed: true } },
      });
      expect(prompt).toContain('"currentAttempt":2');
      expect(prompt).toContain('"currentAttemptOperations"');
      expect(prompt).toContain(verification.id);
      expect(prompt).toContain('"historicalAttemptOperations"');
      expect(prompt).toContain(priorFailure.id);
      expect(prompt).toContain("audit context, not current progress evidence");
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("keeps a current-Attempt operation failure eligible to block progress", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "repair current failure");
    store.claimOperation("current-failure", run.id, run.attempt, "tool.bash", { command: "npm test" });
    const currentFailure = store.updateOperation("current-failure", {
      status: "failed", stage: "execution_failed", error: "tests failed",
      result: { content: [{ type: "text", text: "1 test failed" }], details: { exitCode: 1 } },
    });
    const verdict = semanticVerdict({
      failures: [{
        kind: "progress", key: "current_tests_failed", reason: "The current Attempt still has a failing test operation.",
        disposition: "auto_fixable", operationRefs: [`operation:${currentFailure.id}`],
      }],
    });
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }), { status: 200 });
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({
        run: store.getRun(run.id)!, response: "The test failure still needs repair.", operations: store.listOperations(run.id), progress: undefined,
      });
      expect(audit).toMatchObject({ action: "start_continuation", gates: { progress: { passed: false }, completion: { passed: false } } });
      expect(audit.gates.progress.failures).toEqual([expect.objectContaining({ key: "current_tests_failed" })]);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("keeps an unresolved historical problem blocking through current completion semantics", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "verify whether recovery is complete");
    store.claimOperation("unresolved-prior-failure", run.id, 1, "tool.bash", { command: "npm run migrate" });
    const priorFailure = store.updateOperation("unresolved-prior-failure", {
      status: "failed", stage: "execution_failed", error: "migration failed",
      result: { content: [{ type: "text", text: "migration failed" }], details: { exitCode: 1 } },
    });
    store.db.prepare("UPDATE runs SET attempt=2 WHERE id=?").run(run.id);
    const reason = "The final delivery provides no current verification that the failed migration was repaired.";
    const verdict = semanticVerdict({
      complete: false, reason,
      failures: [{
        kind: "completion", key: "recovery_not_verified", reason, disposition: "auto_fixable",
        operationRefs: [`operation:${priorFailure.id}`],
      }],
    });
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }), { status: 200 });
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({
        run: store.getRun(run.id)!, response: "The earlier migration failed.", operations: store.listOperations(run.id), progress: undefined,
      });
      expect(audit).toMatchObject({ action: "start_continuation", gates: { completion: { passed: false } } });
      expect(audit.gates.completion.failures).toEqual(expect.arrayContaining([expect.objectContaining({ key: "recovery_not_verified" })]));
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("does not carry a prior-Attempt progress snapshot into settlement review", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "recover in a later Attempt");
    store.updateProgressSnapshot(run, failingEvent(run.id, 1));
    store.db.prepare("UPDATE runs SET attempt=2 WHERE id=?").run(run.id);
    let reviewedProgress: unknown = "not-called";
    const reviewer = {
      evaluator: "llm" as const, model: "capture-progress",
      async reviewSettled(input: { progress: unknown }) { reviewedProgress = input.progress; return passingTestAudit(); },
      async reviewAttemptFailure() { return { action: "block_taskrun" as const, reasonCode: "unused", rationale: "unused", confidence: 1 }; },
    };
    const review = await new TaskRunSupervisor(store, reviewer).reviewSettled(store.getRun(run.id)!, 2, "Recovered.");
    expect(review.decision.action).toBe("complete_taskrun");
    expect(reviewedProgress).toBeUndefined();
    store.close();
  });


  it("rejects hallucinated evidence references from the LLM", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "strict evidence refs");
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify({ sourceInput: run.goal, summary: run.goal, objectives: [], acceptanceCriteria: ["Provide verified output"], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "new_task", decisionReason: "test", routerVersion: "test" }), run.id);
    const receipt = [{ criterionId: "ac-1", status: "covered", evidenceRefs: ["check:invented"], reason: "Claimed support." }];
    const payload = semanticVerdict({ criterionCoverage: receipt });
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      await expect(new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run: store.getRun(run.id)!, response: "done", operations: [], progress: undefined })).rejects.toThrow("unknown evidence reference");
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("persists only Core-verified Evidence Quotes in immutable Gate evaluations", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "audit the durable report");
    const policy = { mode: "read_only_analysis", sideEffectRisk: "read_only", evidencePolicy: "operation_receipt", reviewPolicy: "full", policyVersion: "test", confidence: 1, reason: "inspection" } as const;
    const contract = { sourceInput: run.goal, summary: run.goal, objectives: [{ id: "o1", summary: run.goal, timing: "current" as const, kind: "investigate" as const }], acceptanceCriteria: ["The report contains the verified result"], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "new_task" as const, decisionReason: "test", routerVersion: "test", executionPolicy: policy };
    store.db.prepare("UPDATE runs SET contract_json=? WHERE id=?").run(JSON.stringify(contract), run.id);
    store.addArtifact(run.id, { id: "report", title: "Report", kind: "text", content: "header\nverified result\nfooter", uri: "artifact://report" });
    store.upsertPlanItem(run.id, { key: "audit", title: "Audit report", status: "done", required: true, position: 1, schemaVersion: 2, objectiveIds: ["o1"], criterionIds: ["ac-1"], dependencies: [], completionEvidenceRefs: ["artifact:report"] });
    const source = store.resolveEvidenceSources(run.id, ["artifact:report"])[0]!;
    const verdict = semanticVerdict({ criterionCoverage: [{
      criterionId: "ac-1", status: "covered", evidenceRefs: [source.sourceRef],
      evidenceQuotes: [{ sourceRef: source.sourceRef, sourceRevision: source.sourceRevision, sourceHash: source.sourceHash, selector: { kind: "line_range", startLine: 2, endLine: 2 }, quote: "verified result" }],
      reason: "The immutable report contains the result.",
    }] });
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }), { status: 200 });
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const review = await new TaskRunSupervisor(store, new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }))
        .reviewSettled(store.getRun(run.id)!, 8, "The verified result is in the durable report.");
      expect(review.decision).toMatchObject({ action: "complete_taskrun", epistemicStatus: "model_assessed" });
      expect(store.getRun(run.id)?.supervision.latestGates.find((gate) => gate.gateType === "contract")?.criterionCoverage?.[0])
        .toMatchObject({ status: "covered", evidenceRefs: ["artifact:report"], evidenceQuotes: [{ sourceHash: source.sourceHash, quote: "verified result" }] });
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("rejects excessive per-criterion and aggregate Evidence Quote payloads before persistence", async () => {
    const original = globalThis.fetch;
    const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
    const policy = { mode: "read_only_analysis", sideEffectRisk: "read_only", evidencePolicy: "operation_receipt", reviewPolicy: "full", policyVersion: "test", confidence: 1, reason: "inspection" } as const;
    const store = new Store(":memory:");
    try {
      const run = store.createRun(store.createSession().id, "bounded evidence quotes");
      const contract = { sourceInput: run.goal, summary: run.goal, objectives: [], acceptanceCriteria: ["Bounded proof"], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "new_task" as const, decisionReason: "test", routerVersion: "test", executionPolicy: policy };
      store.db.prepare("UPDATE runs SET contract_json=? WHERE id=?").run(JSON.stringify(contract), run.id);
      store.addArtifact(run.id, { id: "bounded", title: "Bounded", kind: "text", content: "proof", uri: "artifact://bounded" });
      const source = store.resolveEvidenceSources(run.id, ["artifact:bounded"])[0]!;
      const quote = { sourceRef: source.sourceRef, sourceRevision: source.sourceRevision, sourceHash: source.sourceHash, selector: { kind: "text_quote", exact: "proof" }, quote: "proof" };
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(semanticVerdict({ criterionCoverage: [{ criterionId: "ac-1", status: "covered", evidenceRefs: [source.sourceRef], evidenceQuotes: Array.from({ length: 17 }, () => quote), reason: "proof" }] })) } }] }), { status: 200 }));
      await expect(new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run: store.getRun(run.id)!, response: "done", operations: [], progress: undefined, evidenceSources: [source] }))
        .rejects.toThrow("more than 16 evidence quotes");

      const aggregateRun = store.createRun(store.createSession().id, "aggregate evidence cap");
      const criteria = Array.from({ length: 9 }, (_, index) => `Criterion ${index + 1}`);
      const chunks = criteria.map((_, index) => `${index}:` + String.fromCharCode(97 + index).repeat(14_998));
      const aggregateContract = { ...contract, sourceInput: aggregateRun.goal, summary: aggregateRun.goal, acceptanceCriteria: criteria, scope: aggregateRun.goal };
      store.db.prepare("UPDATE runs SET contract_json=? WHERE id=?").run(JSON.stringify(aggregateContract), aggregateRun.id);
      store.addArtifact(aggregateRun.id, { id: "large", title: "Large", kind: "text", content: chunks.join("\n"), uri: "artifact://large" });
      const large = store.resolveEvidenceSources(aggregateRun.id, ["artifact:large"])[0]!;
      const coverage = chunks.map((chunk, index) => ({
        criterionId: `ac-${index + 1}`, status: "covered", evidenceRefs: [large.sourceRef], reason: "proof",
        evidenceQuotes: [{ sourceRef: large.sourceRef, sourceRevision: large.sourceRevision, sourceHash: large.sourceHash, selector: { kind: "text_quote", exact: chunk }, quote: chunk }],
      }));
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(semanticVerdict({ criterionCoverage: coverage })) } }] }), { status: 200 }));
      await expect(new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run: store.getRun(aggregateRun.id)!, response: "done", operations: [], progress: undefined, evidenceSources: [large] }))
        .rejects.toThrow("131072-byte verdict limit");
    } finally {
      globalThis.fetch = original;
      store.close();
    }
  });

  it("rejects check-only strict coverage that omits its underlying Operation quote", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "verify with a check receipt");
    const criterion = "The verification passes";
    store.db.prepare("UPDATE runs SET contract_json=? WHERE id=?").run(JSON.stringify({ sourceInput: run.goal, summary: run.goal, objectives: [], acceptanceCriteria: [criterion], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "new_task", decisionReason: "test", routerVersion: "test" }), run.id);
    const operation = upsertTrustedCheck(store, run.id, { key: "verify", title: "Verify", command: "npm test", output: "all tests passed" });
    const verdict = semanticVerdict({ criterionCoverage: [{ criterionId: "ac-1", status: "covered", evidenceRefs: ["check:verify"], evidenceQuotes: [], reason: "The check passed." }] });
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }), { status: 200 });
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      await expect(new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({
        run: store.getRun(run.id)!, response: "Verified.", operations: store.listOperations(run.id), progress: undefined,
        evidenceSources: store.resolveEvidenceSources(run.id, [`operation:${operation.id}`]),
      })).rejects.toThrow("Core-verifiable evidence quote");
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("rejects a check backed by an unrelated valid quote instead of its underlying Operation", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "verify with the exact check receipt");
    const criterion = "The verification passes";
    const policy = { mode: "workspace_mutation", sideEffectRisk: "workspace", evidencePolicy: "trusted_check", reviewPolicy: "full", policyVersion: "test", confidence: 1, reason: "change" } as const;
    store.db.prepare("UPDATE runs SET contract_json=? WHERE id=?").run(JSON.stringify({ sourceInput: run.goal, summary: run.goal, objectives: [], acceptanceCriteria: [criterion], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "new_task", decisionReason: "test", routerVersion: "test", executionPolicy: policy }), run.id);
    const operation = upsertTrustedCheck(store, run.id, { key: "verify", title: "Verify", command: "npm test", output: "all tests passed" });
    store.addArtifact(run.id, { id: "unrelated", title: "Unrelated note", kind: "text", content: "all tests passed", uri: "artifact://unrelated" });
    const [operationSource, artifactSource] = store.resolveEvidenceSources(run.id, [`operation:${operation.id}`, "artifact:unrelated"]);
    const verdict = semanticVerdict({ criterionCoverage: [{
      criterionId: "ac-1", status: "covered", evidenceRefs: ["check:verify", operationSource!.sourceRef, artifactSource!.sourceRef],
      evidenceQuotes: [{ sourceRef: artifactSource!.sourceRef, sourceRevision: artifactSource!.sourceRevision, sourceHash: artifactSource!.sourceHash, selector: { kind: "text_quote", exact: "all tests passed" }, quote: "all tests passed" }],
      reason: "The check passed.",
    }] });
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }), { status: 200 });
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      await expect(new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({
        run: store.getRun(run.id)!, response: "Verified.", operations: store.listOperations(run.id), progress: undefined,
        evidenceSources: [operationSource!, artifactSource!],
      })).rejects.toThrow(`must quote the underlying Operation operation:${operation.id}`);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("selects explicitly linked old evidence independently of the recent operation window", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "use the early receipt");
    const policy = { mode: "read_only_analysis", sideEffectRisk: "read_only", evidencePolicy: "operation_receipt", reviewPolicy: "full", policyVersion: "test", confidence: 1, reason: "inspection" } as const;
    const contract = { sourceInput: run.goal, summary: run.goal, objectives: [{ id: "o1", summary: run.goal, timing: "current" as const, kind: "investigate" as const }], acceptanceCriteria: ["Use the durable early receipt"], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "new_task" as const, decisionReason: "test", routerVersion: "test", executionPolicy: policy };
    store.db.prepare("UPDATE runs SET contract_json=? WHERE id=?").run(JSON.stringify(contract), run.id);
    store.claimOperation("early", run.id, 1, "tool.bash", { command: "rg early" });
    store.updateOperation("early", { status: "succeeded", effects: [{ kind: "workspace", action: "read_only" }], result: { details: { exitCode: 0 } } });
    for (let index = 0; index < 20; index += 1) {
      store.claimOperation(`recent-${index}`, run.id, 1, "tool.bash", { command: `rg ${index}` });
      store.updateOperation(`recent-${index}`, { status: "succeeded", effects: [{ kind: "workspace", action: "read_only" }], result: { details: { exitCode: 0 } } });
    }
    store.upsertPlanItem(run.id, { key: "audit", title: "Audit", status: "done", required: true, position: 1, schemaVersion: 2, objectiveIds: ["o1"], criterionIds: ["ac-1"], dependencies: [], completionEvidenceRefs: ["operation:early"] });
    let observed: string[] = [];
    const capture: SupervisorReviewer = {
      evaluator: "llm", model: "capture-linked-evidence",
      async reviewSettled(input) { observed = input.operations.map((operation) => operation.id); return passingTestAudit(); },
      async reviewAttemptFailure() { return { action: "block_taskrun", reasonCode: "unused", rationale: "unused", confidence: 1 }; },
    };
    await new TaskRunSupervisor(store, capture).reviewSettled(store.getRun(run.id)!, 9, "done");
    expect(observed).toContain("early");
    expect(observed).toHaveLength(17);
    store.close();
  });

  it("retains an explicitly linked early receipt through the final provider projection", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "use the linked early receipt");
    const policy = { mode: "read_only_analysis", sideEffectRisk: "read_only", evidencePolicy: "operation_receipt", reviewPolicy: "full", policyVersion: "test", confidence: 1, reason: "inspection" } as const;
    const contract = { sourceInput: run.goal, summary: run.goal, objectives: [{ id: "o1", summary: run.goal, timing: "current" as const, kind: "investigate" as const }], acceptanceCriteria: ["Use the durable early receipt"], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "new_task" as const, decisionReason: "test", routerVersion: "test", executionPolicy: policy };
    store.db.prepare("UPDATE runs SET contract_json=? WHERE id=?").run(JSON.stringify(contract), run.id);
    store.claimOperation("early", run.id, 1, "tool.bash", { command: "rg early" });
    store.updateOperation("early", { status: "succeeded", effects: [{ kind: "workspace", action: "read_only" }], result: { output: "early receipt verified" } });
    for (let index = 0; index < 20; index += 1) {
      store.claimOperation(`recent-${index}`, run.id, 1, "tool.bash", { command: `rg ${index}` });
      store.updateOperation(`recent-${index}`, { status: "succeeded", effects: [{ kind: "workspace", action: "read_only" }], result: { output: `recent ${index}` } });
    }
    store.upsertPlanItem(run.id, { key: "audit", title: "Audit", status: "done", required: true, position: 1, schemaVersion: 2, objectiveIds: ["o1"], criterionIds: ["ac-1"], dependencies: [], completionEvidenceRefs: ["operation:early"] });
    const earlySource = store.resolveEvidenceSources(run.id, ["operation:early"])[0]!;
    expect(earlySource.content).toContain("early receipt verified");
    const verdict = semanticVerdict({ criterionCoverage: [{
      criterionId: "ac-1", status: "covered", evidenceRefs: [earlySource.sourceRef],
      evidenceQuotes: [{
        sourceRef: earlySource.sourceRef, sourceRevision: earlySource.sourceRevision, sourceHash: earlySource.sourceHash,
        selector: { kind: "text_quote", exact: "early receipt verified" }, quote: "early receipt verified",
      }],
      reason: "The linked receipt verifies the result.",
    }] });
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }), { status: 200 });
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const review = await new TaskRunSupervisor(store, new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }))
        .reviewSettled(store.getRun(run.id)!, 9, "Verified by the linked early receipt.");
      expect(review.decision.action).toBe("complete_taskrun");
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("rejects hallucinated operation references on semantic failures", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "strict failure refs");
    const payload = semanticVerdict({
      failures: [{
        kind: "completion", key: "invented_receipt", reason: "An invented operation allegedly failed.",
        disposition: "auto_fixable", operationRefs: ["operation:invented"],
      }],
    });
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      await expect(new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({
        run, response: "done", operations: [], progress: undefined,
      })).rejects.toThrow("invalid failure operation references");
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("uses one authoritative criterion coverage receipt set", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "single coverage owner");
    const criterion = "Explain the result";
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify({ sourceInput: run.goal, summary: run.goal, objectives: [], acceptanceCriteria: [criterion], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "discussion", decisionReason: "test", routerVersion: "test" }), run.id);
    const payload = semanticVerdict({ criterionCoverage: [{ criterionId: "ac-1", status: "covered", evidenceRefs: [], reason: "The response directly explains the result." }] });
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run: store.getRun(run.id)!, response: "explanation", operations: [], progress: undefined });
      expect(audit.action).toBe("complete_taskrun");
      expect(audit.gates.contract.criterionCoverage).toHaveLength(1);
      expect(audit.gates.completion.criterionCoverage).toBeUndefined();
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("derives full gates and action from the compact semantic verdict", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "compact semantic verdict");
    const criterion = "Explain the inspected result";
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify({ sourceInput: run.goal, summary: run.goal, objectives: [], acceptanceCriteria: [criterion], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "new_task", decisionReason: "test", routerVersion: "test" }), run.id);
    store.upsertPlanItem(run.id, { key: "inspect", title: "Inspect", status: "done", required: true, position: 1 });
    const compact = { delivery: { complete: false, relevant: true, contradictory: false, reason: "The candidate omits the root cause." }, criterionCoverage: [{ criterionId: "ac-1", status: "unsupported", evidenceRefs: [], reason: "No root cause is given." }], failures: [] };
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(compact) } }] }), { status: 200 });
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run: store.getRun(run.id)!, response: "Partial answer", operations: [], progress: undefined });
      expect(audit).toMatchObject({ action: "start_continuation", reasonCode: "authoritative_start_continuation", gates: { progress: { passed: true }, evidence: { passed: true }, contract: { passed: false }, completion: { passed: false }, continuation: { passed: true } } });
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("rejects a malformed Supervisor schema locally without another model call", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "retry audit only");
    let requests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      requests += 1;
      const content = JSON.stringify({ action: "complete_taskrun" });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      await expect(new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run, response: "done", operations: [], progress: undefined })).rejects.toThrow("no repair LLM was called");
      expect(requests).toBe(1);
      expect(store.getRun(run.id)?.attempt).toBe(1);
      expect(store.getRun(run.id)?.continuations).toHaveLength(0);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("waits for durable control delivery before invoking the LLM reviewer", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "wait");
    store.enqueueControl(run.id, "control", "steer", "correct it", 32);
    const review = await new TaskRunSupervisor(store, new TestSupervisorReviewer()).reviewSettled(run, 3, "candidate");
    expect(review).toMatchObject({ gates: [], decision: { action: "wait_for_runtime", evaluator: "system" } }); store.close();
  });
  it("blocks on a retryable Supervisor transport failure without rerunning completed Agent work", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "transport failure");
    let requests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { requests += 1; return new Response("upstream unavailable", { status: 503 }); };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run, response: "done", operations: [], progress: undefined });
      expect(audit).toMatchObject({ action: "block_taskrun", reasonCode: "supervisor_transport_unavailable", evaluator: "system", evaluatorModel: "deterministic-transport-recovery-v1", gates: { completion: { passed: false }, continuation: { passed: false } } });
      expect(requests).toBe(1);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("does not guess criterion coverage from generic evidence when semantic transport is unavailable", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "verified delivery");
    store.upsertPlanItem(run.id, { key: "implement", title: "Implement", status: "done", required: true, position: 1 });
    upsertTrustedCheck(store, run.id, { key: "verify", title: "Verify", command: "npm test", output: "286 tests passed" });
    let requests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { requests += 1; return new Response("unavailable", { status: 503 }); };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const current = store.getRun(run.id)!;
      expect(current.completionGate.passed).toBe(true);
      const audit = await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run: current, response: "A complete standalone delivery with root cause, implementation details, deployment evidence, and verification results.".repeat(3), operations: store.listOperations(run.id), progress: undefined });
      expect(audit).toMatchObject({ action: "block_taskrun", reasonCode: "supervisor_transport_unavailable", gates: { completion: { passed: false }, contract: { passed: false } } });
      expect(audit.gates.contract.criterionCoverage?.every((item) => item.status === "blocked")).toBe(true);
      expect(requests).toBe(1);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("blocks after a repeated semantic judge transport failure instead of looping continuations", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "repeat judge failure");
    const previous = { id: "previous", runId: run.id, evaluator: "llm", evaluatorModel: "audit-model", attempt: run.attempt, checkpointSeq: 1, trigger: "settled", action: "start_continuation", reasonCode: "supervisor_transport_unavailable", rationale: "retry", confidence: 1, instruction: "", candidateResponseHash: "", status: "executed", error: "", createdAt: Date.now(), executedAt: Date.now() } as const;
    store.recordSupervisorDecision(previous);
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run: store.getRun(run.id)!, response: "candidate", operations: [], progress: undefined });
      expect(audit).toMatchObject({ action: "block_taskrun", reasonCode: "supervisor_transport_unavailable", evaluator: "system", evaluatorModel: "deterministic-transport-recovery-v1", gates: { completion: { passed: false }, continuation: { passed: false } } });
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("persists deterministic evaluator provenance for transport recovery", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "transport provenance");
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const supervisor = new TaskRunSupervisor(store, new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }));
      const review = await supervisor.reviewSettled(store.getRun(run.id)!, 2, "candidate");
      expect(review.decision).toMatchObject({ evaluator: "system", evaluatorModel: "deterministic-transport-recovery-v1", reasonCode: "supervisor_transport_unavailable", epistemicStatus: "degraded" });
      expect(store.listSupervisorDecisions(run.id).at(-1)?.epistemicStatus).toBe("degraded");
      expect(review.gates.every((gate) => gate.evaluator === "system" && gate.evaluatorModel === "deterministic-transport-recovery-v1")).toBe(true);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("does not pay a second timeout when the lightweight and main Supervisor models share one upstream", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "same upstream outage");
    const models: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => { models.push(String(JSON.parse(String(init?.body)).model)); return new Response("unavailable", { status: 503 }); };
    try {
      const light = { id: "gpt-5.6-luna", baseUrl: "https://audit.test/v1" } as never;
      const main = { id: "gpt-5.6-sol", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model: light, fallbackModel: main, credential: TEST_CREDENTIAL }).reviewSettled({ run, response: "done", operations: [], progress: undefined });
      expect(audit.action).toBe("block_taskrun");
      expect(models).toEqual(["gpt-5.6-luna"]);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("falls back once from the lightweight Supervisor model to a main model on a different upstream", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "fallback audit");
    const models: string[] = [];
    const valid = semanticVerdict();
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      const modelId = String(JSON.parse(String(init?.body)).model);
      models.push(modelId);
      return modelId === "gpt-5.6-luna" ? new Response("unavailable", { status: 503 }) : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(valid) } }] }), { status: 200 });
    };
    try {
      const light = { id: "gpt-5.6-luna", baseUrl: "https://light-audit.test/v1" } as never;
      const main = { id: "gpt-5.6-sol", baseUrl: "https://main-audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model: light, fallbackModel: main, credential: TEST_CREDENTIAL, timeoutMs: 1_000 }).reviewSettled({ run, response: "done", operations: [], progress: undefined });
      expect(audit.action).toBe("complete_taskrun");
      expect(models).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("starts the Supervisor response timeout after credential resolution", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "slow credential resolution");
    const original = globalThis.fetch;
    let fetchSignalAborted = true;
    globalThis.fetch = async (_url, init) => {
      fetchSignalAborted = (init?.signal as AbortSignal | undefined)?.aborted ?? false;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(semanticVerdict()) } }] }), { status: 200 });
    };
    try {
      const credential = {
        reference: credentialReference("SLOW_TEST_API_KEY"),
        resolver: {
          configured: async () => true,
          resolve: async () => { await new Promise((resolve) => setTimeout(resolve, 25)); return "secret"; },
        },
      };
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1", maxTokens: 2_048 } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, credential, timeoutMs: 10 }).reviewSettled({ run, response: "done", operations: [], progress: undefined });
      expect(fetchSignalAborted).toBe(false);
      expect(audit.action).toBe("complete_taskrun");
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("distinguishes Supervisor credential and response-header failures", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "request stage failures");
    const model = { id: "audit-model", baseUrl: "https://audit.test/v1", maxTokens: 2_048 } as never;
    const original = globalThis.fetch;
    try {
      const fetchProbe = vi.fn<typeof fetch>();
      globalThis.fetch = fetchProbe;
      await expect(new OpenAiSupervisorReviewer({
        model,
        credential: {
          reference: credentialReference("FAILED_TEST_API_KEY"),
          resolver: { configured: async () => true, resolve: async () => { throw new Error("vault unavailable"); } },
        },
        timeoutMs: 10,
      }).reviewAttemptFailure({ run, error: "failed" })).rejects.toThrow("credential resolution failed");
      expect(fetchProbe).not.toHaveBeenCalled();

      globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        const fail = () => reject(signal.reason);
        if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true });
      });
      await expect(new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL, timeoutMs: 10 })
        .reviewAttemptFailure({ run, error: "failed" })).rejects.toThrow("response headers timed out");
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("bounds the Supervisor request body and removes redundant contract fields", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "G".repeat(8_000));
    const contract = { sourceInput: "S".repeat(20_000), summary: "summary", objectives: [], acceptanceCriteria: [], scope: "scope", nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "new_task", decisionReason: "D".repeat(10_000), routerVersion: "test" };
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify(contract), run.id);
    upsertTrustedCheck(store, run.id, { key: "verify", title: "Verify", command: "C".repeat(10_000), output: "E".repeat(20_000) });
    store.addArtifact(run.id, { id: "large", title: "Large", kind: "report", content: "A".repeat(20_000), uri: "artifact://large" });
    const valid = semanticVerdict();
    let requestBody = "";
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => { requestBody = String(init?.body); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(valid) } }] }), { status: 200 }); };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1", maxTokens: 2_048 } as never;
      await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run: store.getRun(run.id)!, response: "R".repeat(40_000), operations: store.listOperations(run.id), progress: undefined });
      expect(new TextEncoder().encode(requestBody).byteLength).toBeLessThan(30_000);
      const parsedRequest = JSON.parse(requestBody) as { max_completion_tokens?: number; messages: Array<{ content: string }> };
      expect(parsedRequest.max_completion_tokens).toBe(2_048);
      const prompt = String(parsedRequest.messages[0].content);
      expect(prompt).not.toContain("sourceInput");
      expect(prompt).not.toContain("decisionReason");
      expect(prompt).toContain('"key":"verify"');
      expect(prompt).toContain('"id":"large"');
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("frames open-ended research criteria as terminal conditions and includes the full deliverable set", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "research public pain evidence");
    const criterion = "Deliver five files and reach 150–300 traceable raw findings before final ICP synthesis";
    const executionPolicy = { mode: "read_only_analysis", sideEffectRisk: "read_only", evidencePolicy: "operation_receipt", reviewPolicy: "full", policyVersion: "test", confidence: 1, reason: "research" } as const;
    const contract = { sourceInput: run.goal, summary: run.goal, objectives: [{ id: "objective-1", summary: run.goal, timing: "current" as const, kind: "investigate" as const }], acceptanceCriteria: [criterion], scope: "public evidence", nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "new_task" as const, decisionReason: "test", routerVersion: "test", executionPolicy };
    store.db.prepare("UPDATE runs SET contract_json=? WHERE id=?").run(JSON.stringify(contract), run.id);
    store.upsertPlanItem(run.id, { key: "research", title: "Complete research", status: "done", required: true, position: 1 });
    for (let index = 1; index <= 20; index += 1) store.addArtifact(run.id, { id: `artifact-${index}`, title: `Deliverable ${index}`, kind: "research", content: `evidence ${index}`, uri: `artifact://${index}` });
    let prompt = "";
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      prompt = (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[0].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(semanticVerdict({ criterionCoverage: [{ criterionId: "ac-1", status: "covered", evidenceRefs: ["artifact:artifact-1"], reason: "The settled deliverables satisfy the terminal condition." }] })) } }] }), { status: 200 });
    };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run: store.getRun(run.id)!, response: "Research complete.", operations: [], progress: undefined });
      expect(prompt).toContain("Acceptance criteria describe final settlement, not intermediate milestones");
      expect(prompt).toContain('"id":"artifact-1"');
      expect(prompt).toContain('"id":"artifact-20"');
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("projects deterministic CSV structure and row counts for open research audit", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "audit raw findings");
    const criterion = "raw_findings.csv contains 150–300 traceable records with every required field";
    const executionPolicy = { mode: "read_only_analysis", sideEffectRisk: "read_only", evidencePolicy: "operation_receipt", reviewPolicy: "full", policyVersion: "test", confidence: 1, reason: "research" } as const;
    const contract = { sourceInput: run.goal, summary: run.goal, objectives: [{ id: "objective-1", summary: run.goal, timing: "current" as const, kind: "investigate" as const }], acceptanceCriteria: [criterion], scope: "public evidence", nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "new_task" as const, decisionReason: "test", routerVersion: "test", executionPolicy };
    store.db.prepare("UPDATE runs SET contract_json=? WHERE id=?").run(JSON.stringify(contract), run.id);
    store.upsertPlanItem(run.id, { key: "research", title: "Complete research", status: "done", required: true, position: 1 });
    const header = "source_url,platform,date,author_context,raw_quote,pain_category,current_workaround,team_or_solo,willingness_to_pay_signal,severity";
    const rows = Array.from({ length: 150 }, (_, index) => `https://example.test/${index},forum,2026-01-01,public context,"pain ${index}, with detail",workflow,manual,team,stated,high`);
    store.addArtifact(run.id, { id: "raw_findings.csv", title: "raw_findings.csv", kind: "text/csv", content: [header, ...rows].join("\n"), uri: "artifact://raw_findings.csv" });
    let prompt = "";
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      prompt = (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[0].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(semanticVerdict({ criterionCoverage: [{ criterionId: "ac-1", status: "covered", evidenceRefs: ["artifact:raw_findings.csv"], reason: "The CSV structure and row count satisfy the criterion." }] })) } }] }), { status: 200 });
    };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run: store.getRun(run.id)!, response: "Research complete.", operations: [], progress: undefined });
      expect(prompt).toContain('"dataRows":150');
      expect(prompt).toContain('"quoteBalanced":true');
      expect(prompt).toContain('"source_url","platform","date","author_context","raw_quote"');
      expect(prompt).toContain('"contentSha256"');
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("reviews long candidates with a bounded head-tail projection that preserves the final delivery", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "long delivery");
    const ending = "FINAL DELIVERY: implementation complete; all regression checks passed; no deployment was requested.";
    const response = `Opening context.\n${"middle detail 中文证据。".repeat(2_000)}\n${ending}`;
    const valid = semanticVerdict();
    let requestBody = "";
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => { requestBody = String(init?.body); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(valid) } }] }), { status: 200 }); };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1", maxTokens: 1_024 } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run, response, operations: [], progress: undefined });
      expect(audit.action).toBe("complete_taskrun");
      expect(new TextEncoder().encode(requestBody).byteLength).toBeLessThan(25_000);
      const prompt = (JSON.parse(requestBody) as { messages: Array<{ content: string }> }).messages[0].content;
      expect(prompt).toContain("Opening context.");
      expect(prompt).toContain(ending);
      expect(prompt).toContain('"strategy":"head_tail"');
      expect(prompt).toContain('"completeSourcePreserved":true');
      expect(prompt).toContain('"modelOutputTruncated":false');
      expect(prompt).not.toContain("candidateResponseTruncated");
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("corrects a projection-only truncation verdict without creating an Agent continuation", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "long candidate correction");
    const failure = { kind: "delivery", key: "final_delivery_truncated", reason: "Candidate response was truncated by the review projection.", disposition: "auto_fixable" as const };
    const invalid = semanticVerdict({ complete: false, reason: failure.reason, failures: [failure] });
    let requests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { requests += 1; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(invalid) } }] }), { status: 200 }); };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const response = `${"long middle\n".repeat(1_000)}\nFINAL: complete and verified.`;
      const audit = await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run, response, operations: [], progress: undefined });
      expect(audit.action).toBe("complete_taskrun");
      expect(audit.reasonCode).toBe("projection_artifact_ignored");
      expect(requests).toBe(1);
      expect(store.getRun(run.id)?.attempt).toBe(1);
      expect(store.getRun(run.id)?.continuations).toHaveLength(0);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("locally removes repeated projection-only truncation failures without another LLM call", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "projection loop fuse");
    const failure = { kind: "delivery", key: "candidate_truncated", reason: "The answer is truncated because the middle was omitted.", disposition: "auto_fixable" as const };
    const invalid = semanticVerdict({ complete: false, reason: failure.reason, failures: [failure] });
    let requests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { requests += 1; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(invalid) } }] }), { status: 200 }); };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run, response: `${"detail".repeat(2_000)}\nFINAL complete.`, operations: [], progress: undefined });
      expect(audit).toMatchObject({ action: "complete_taskrun", reasonCode: "projection_artifact_ignored" });
      expect(requests).toBe(1);
      expect(store.getRun(run.id)?.continuations).toHaveLength(0);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("still allows a genuine model length stop to be classified as truncated", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "real output truncation");
    const failure = { kind: "delivery", key: "final_delivery_truncated", reason: "The model output ended at its length limit.", disposition: "auto_fixable" as const };
    const auditPayload = semanticVerdict({ complete: false, reason: failure.reason, failures: [failure] });
    let requests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { requests += 1; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(auditPayload) } }] }), { status: 200 }); };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run, response: "unfinished ".repeat(1_000), modelOutputTruncated: true, operations: [], progress: undefined });
      expect(audit.action).toBe("start_continuation");
      expect(requests).toBe(1);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("does not resend an HTTP 413 payload to the fallback model", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "too large");
    const models: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => { models.push(String(JSON.parse(String(init?.body)).model)); return new Response("body too large", { status: 413 }); };
    try {
      const light = { id: "gpt-5.6-luna", baseUrl: "https://audit.test/v1" } as never;
      const main = { id: "gpt-5.6-sol", baseUrl: "https://audit.test/v1" } as never;
      await expect(new OpenAiSupervisorReviewer({ model: light, fallbackModel: main, credential: TEST_CREDENTIAL }).reviewSettled({ run, response: "done", operations: [], progress: undefined })).rejects.toThrow("API 413");
      expect(models).toEqual(["gpt-5.6-luna"]);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("maps one coverage receipt per criterion by stable id even when the LLM returns them out of order", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "stable coverage mapping");
    const criteria = ["First exact criterion", "Second exact criterion"];
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify({ sourceInput: run.goal, summary: run.goal, objectives: [], acceptanceCriteria: criteria, scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "new_task", decisionReason: "test", routerVersion: "test" }), run.id);
    const valid = semanticVerdict({ criterionCoverage: [{ criterionId: "ac-2", status: "covered", evidenceRefs: [], reason: "Second is covered." }, { criterionId: "ac-1", status: "covered", evidenceRefs: [], reason: "First is covered." }] });
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(valid) } }] }), { status: 200 });
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run: store.getRun(run.id)!, response: "done", operations: [], progress: undefined });
      expect(audit.gates.contract.criterionCoverage?.map((item) => item.criterion)).toEqual(criteria);
      expect(audit.gates.contract.criterionCoverage?.map((item) => item.reason)).toEqual(["First is covered.", "Second is covered."]);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("rejects missing coverage after one model call", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "correct missing coverage");
    const criteria = ["Criterion one", "Criterion two"];
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify({ sourceInput: run.goal, summary: run.goal, objectives: [], acceptanceCriteria: criteria, scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "new_task", decisionReason: "test", routerVersion: "test" }), run.id);
    let requests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      requests += 1;
      const content = semanticVerdict({ criterionCoverage: [{ criterionId: "ac-1", status: "covered", evidenceRefs: [], reason: "One." }] });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
    };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      await expect(new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run: store.getRun(run.id)!, response: "done", operations: [], progress: undefined })).rejects.toThrow("missing: ac-2");
      expect(requests).toBe(1);
      expect(store.getRun(run.id)?.attempt).toBe(1);
      expect(store.getRun(run.id)?.continuations).toHaveLength(0);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("repairs a bounded missing-comma JSON syntax error without rerunning the Agent", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "repair malformed audit JSON");
    const malformed = JSON.stringify(semanticVerdict()).replace(',"criterionCoverage"', '"criterionCoverage"');
    let requests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { requests += 1; return new Response(JSON.stringify({ choices: [{ message: { content: malformed } }] }), { status: 200 }); };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run, response: "done", operations: [], progress: undefined });
      expect(audit.action).toBe("complete_taskrun");
      expect(requests).toBe(1);
      expect(store.getRun(run.id)?.attempt).toBe(1);
      expect(store.getRun(run.id)?.continuations).toHaveLength(0);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("keeps malformed JSON correction bounded and never creates an Agent continuation", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "bounded malformed audit");
    let requests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { requests += 1; return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"complete_taskrun","rationale":"unterminated}' } }] }), { status: 200 }); };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      await expect(new OpenAiSupervisorReviewer({ model, credential: TEST_CREDENTIAL }).reviewSettled({ run, response: "done", operations: [], progress: undefined })).rejects.toThrow("no repair LLM was called");
      expect(requests).toBe(1);
      expect(store.getRun(run.id)?.attempt).toBe(1);
      expect(store.getRun(run.id)?.continuations).toHaveLength(0);
    } finally { globalThis.fetch = original; store.close(); }
  });

});
