import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { Store } from "../src/store/store.js";
import { TaskRunSupervisor } from "../src/core/supervisor.js";
import { OpenAiSupervisorReviewer, TestSupervisorReviewer, passingTestAudit, type SupervisorAudit } from "../src/core/supervisor-reviewer.js";

function failingEvent(runId: string, seq: number) { return { runId, seq, type: "tool.completed", data: { toolName: "bash", isError: true }, createdAt: Date.now() }; }
function failedAudit(action: SupervisorAudit["action"], reasonCode: string, failure: { kind: string; key: string; reason: string; disposition: "auto_fixable" | "needs_user_input" | "needs_approval" | "external_dependency" | "runtime_transient" | "non_recoverable" }, criteria: string[] = []): SupervisorAudit {
  const coverage = criteria.map((criterion) => ({ criterion, status: "unsupported" as const, evidenceRefs: [], reason: failure.reason }));
  const gate = (failures = [failure], criterionCoverage = undefined as typeof coverage | undefined) => ({ passed: failures.length === 0, failures, criterionCoverage, summary: failures.length ? failure.reason : "Passed." });
  return { action, reasonCode, rationale: failure.reason, confidence: .97, gates: { progress: gate(failure.kind === "progress" ? [failure] : []), evidence: gate(failure.kind === "evidence" ? [failure] : []), contract: gate(failure.kind === "contract" ? [failure] : [], coverage), completion: gate([failure], coverage), continuation: gate(failure.disposition === "auto_fixable" ? [] : [failure]) } };
}

describe("TaskRunSupervisor LLM audit", () => {
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
    store.close();
  });

  it("skips the LLM and requests evidence when only required checks fail", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "missing check evidence");
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
    expect(review.decision).toMatchObject({ action: "request_evidence", evaluator: "system", reasonCode: "deterministic_check_incomplete" });
    expect(review.gates.find((gate) => gate.gateType === "evidence")?.failures[0]).toMatchObject({ key: "verify", disposition: "auto_fixable" });
    store.close();
  });

  it("completes a low-risk single-answer discussion without a general Supervisor call", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "explain caching");
    const contract = { sourceInput: run.goal, summary: run.goal, objectives: [{ id: "objective-1", summary: run.goal, timing: "current" as const, kind: "answer" as const }], acceptanceCriteria: ["Explain caching clearly"], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "discussion" as const, decisionReason: "test", routerVersion: "test" };
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify(contract), run.id);
    let calls = 0;
    const reviewer = {
      evaluator: "llm" as const, model: "must-not-run",
      async reviewSettled() { calls += 1; return passingTestAudit(); },
      async reviewAttemptFailure() { return { action: "block_taskrun" as const, reasonCode: "unused", rationale: "unused", confidence: 1 }; },
    };
    const current = store.getRun(run.id)!;
    expect(current.completionGate.passed).toBe(true);
    const review = await new TaskRunSupervisor(store, reviewer).reviewSettled(current, 2, "Caching stores reusable results so repeated work completes faster.");
    expect(calls).toBe(0);
    expect(review.decision).toMatchObject({ action: "complete_taskrun", evaluator: "system", evaluatorModel: "deterministic-lightweight-delivery-v1", reasonCode: "lightweight_delivery_validated" });
    expect(review.gates.find((gate) => gate.gateType === "contract")?.criterionCoverage).toEqual([expect.objectContaining({ criterion: "Explain caching clearly", status: "covered" })]);
    store.close();
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
    store.upsertCheck(run.id, { key: "verify", title: "Verify", status: "passed", required: true, command: "npm test", evidence: "fresh pass", stale: false });
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

  it("accepts completion only when the structured LLM completion gate passes", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "complete");
    const review = await new TaskRunSupervisor(store, new TestSupervisorReviewer(passingTestAudit())).reviewSettled(run, 4, "standalone result");
    expect(review.decision).toMatchObject({ action: "complete_taskrun", reasonCode: "all_gates_passed", evaluator: "llm" });
    expect(review.gates.every((gate) => gate.passed)).toBe(true); store.close();
  });

  it("maps LLM evidence findings to request_evidence", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "evidence");
    const audit = failedAudit("request_evidence", "verification_evidence_required", { kind: "evidence", key: "test", reason: "Fresh independent evidence is missing.", disposition: "auto_fixable" });
    const review = await new TaskRunSupervisor(store, new TestSupervisorReviewer(audit)).reviewSettled(run, 5, "result");
    expect(review.decision.action).toBe("request_evidence"); expect(review.gates.find((gate) => gate.gateType === "evidence")?.passed).toBe(false); store.close();
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


  it("rejects hallucinated evidence references from the LLM", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "strict evidence refs");
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify({ sourceInput: run.goal, summary: run.goal, objectives: [], acceptanceCriteria: ["Provide verified output"], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "new_task", decisionReason: "test", routerVersion: "test" }), run.id);
    const payload = { action: "complete_taskrun", reasonCode: "all_gates_passed", rationale: "Complete.", confidence: 1, gates: Object.fromEntries(["progress", "evidence", "continuation"].map((type) => [type, { passed: true, summary: "Passed.", failures: [] }])) as Record<string, unknown> };
    const receipt = [{ criterionId: "ac-1", status: "covered", evidenceRefs: ["check:invented"], reason: "Claimed support." }];
    payload.gates.contract = { passed: true, summary: "Passed.", failures: [], criterionCoverage: receipt };
    payload.gates.completion = { passed: true, summary: "Passed.", failures: [], criterionCoverage: receipt };
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      await expect(new OpenAiSupervisorReviewer({ model, apiKey: "secret" }).reviewSettled({ run: store.getRun(run.id)!, response: "done", operations: [], progress: undefined })).rejects.toThrow("unknown evidence reference");
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("uses one authoritative contract coverage receipt set and does not require completion duplication", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "single coverage owner");
    const criterion = "Explain the result";
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify({ sourceInput: run.goal, summary: run.goal, objectives: [], acceptanceCriteria: [criterion], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "discussion", decisionReason: "test", routerVersion: "test" }), run.id);
    const payload = { action: "complete_taskrun", reasonCode: "all_gates_passed", rationale: "Complete.", confidence: 1, gates: Object.fromEntries(["progress", "evidence", "completion", "continuation"].map((type) => [type, { passed: true, summary: "Passed.", failures: [] }])) as Record<string, unknown> };
    payload.gates.contract = { passed: true, summary: "Covered.", failures: [], criterionCoverage: [{ criterionId: "ac-1", status: "covered", evidenceRefs: [], reason: "The response directly explains the result." }] };
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, apiKey: "secret" }).reviewSettled({ run: store.getRun(run.id)!, response: "explanation", operations: [], progress: undefined });
      expect(audit.action).toBe("complete_taskrun");
      expect(audit.gates.contract.criterionCoverage).toHaveLength(1);
      expect(audit.gates.completion.criterionCoverage).toBeUndefined();
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("retries malformed Supervisor audit output internally without creating another Agent attempt", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "retry audit only");
    let requests = 0;
    const valid = { action: "complete_taskrun", reasonCode: "all_gates_passed", rationale: "Complete.", confidence: 1, gates: { progress: { passed: true, summary: "Passed.", failures: [] }, evidence: { passed: true, summary: "Passed.", failures: [] }, contract: { passed: true, summary: "Passed.", failures: [], criterionCoverage: [] }, completion: { passed: true, summary: "Passed.", failures: [] }, continuation: { passed: true, summary: "Passed.", failures: [] } } };
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      requests += 1;
      const content = requests === 1 ? JSON.stringify({ action: "complete_taskrun" }) : JSON.stringify(valid);
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, apiKey: "secret" }).reviewSettled({ run, response: "done", operations: [], progress: undefined });
      expect(audit.action).toBe("complete_taskrun");
      expect(requests).toBe(2);
      expect(store.getRun(run.id)?.attempt).toBe(1);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("waits for durable control delivery before invoking the LLM reviewer", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "wait");
    store.enqueueControl(run.id, "control", "steer", "correct it", 32);
    const review = await new TaskRunSupervisor(store, new TestSupervisorReviewer()).reviewSettled(run, 3, "candidate");
    expect(review).toMatchObject({ gates: [], decision: { action: "wait_for_runtime", evaluator: "system" } }); store.close();
  });
  it("turns a retryable Supervisor transport failure into a conservative continuation without three review requests", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "transport failure");
    let requests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { requests += 1; return new Response("upstream unavailable", { status: 503 }); };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, apiKey: "secret" }).reviewSettled({ run, response: "done", operations: [], progress: undefined });
      expect(audit).toMatchObject({ action: "start_continuation", reasonCode: "supervisor_transport_unavailable", evaluator: "system", evaluatorModel: "deterministic-transport-recovery-v1", gates: { completion: { passed: false }, continuation: { passed: true } } });
      expect(requests).toBe(1);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("does not guess criterion coverage from generic evidence when semantic transport is unavailable", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "verified delivery");
    store.upsertPlanItem(run.id, { key: "implement", title: "Implement", status: "done", required: true, position: 1 });
    store.upsertCheck(run.id, { key: "verify", title: "Verify", status: "passed", required: true, command: "npm test", evidence: "286 tests passed", stale: false });
    let requests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { requests += 1; return new Response("unavailable", { status: 503 }); };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const current = store.getRun(run.id)!;
      expect(current.completionGate.passed).toBe(true);
      const audit = await new OpenAiSupervisorReviewer({ model, apiKey: "secret" }).reviewSettled({ run: current, response: "A complete standalone delivery with root cause, implementation details, deployment evidence, and verification results.".repeat(3), operations: [], progress: undefined });
      expect(audit).toMatchObject({ action: "start_continuation", reasonCode: "supervisor_transport_unavailable", gates: { completion: { passed: false }, contract: { passed: false } } });
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
      const audit = await new OpenAiSupervisorReviewer({ model, apiKey: "secret" }).reviewSettled({ run: store.getRun(run.id)!, response: "candidate", operations: [], progress: undefined });
      expect(audit).toMatchObject({ action: "block_taskrun", reasonCode: "supervisor_transport_unavailable", evaluator: "system", evaluatorModel: "deterministic-transport-recovery-v1", gates: { completion: { passed: false }, continuation: { passed: false } } });
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("persists deterministic evaluator provenance for transport recovery", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "transport provenance");
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const supervisor = new TaskRunSupervisor(store, new OpenAiSupervisorReviewer({ model, apiKey: "secret" }));
      const review = await supervisor.reviewSettled(store.getRun(run.id)!, 2, "candidate");
      expect(review.decision).toMatchObject({ evaluator: "system", evaluatorModel: "deterministic-transport-recovery-v1", reasonCode: "supervisor_transport_unavailable" });
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
      const audit = await new OpenAiSupervisorReviewer({ model: light, fallbackModel: main, apiKey: "secret" }).reviewSettled({ run, response: "done", operations: [], progress: undefined });
      expect(audit.action).toBe("start_continuation");
      expect(models).toEqual(["gpt-5.6-luna"]);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("falls back once from the lightweight Supervisor model to a main model on a different upstream", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "fallback audit");
    const models: string[] = [];
    const valid = { action: "complete_taskrun", reasonCode: "all_gates_passed", rationale: "Complete.", confidence: 1, gates: { progress: { passed: true, summary: "Passed.", failures: [] }, evidence: { passed: true, summary: "Passed.", failures: [] }, contract: { passed: true, summary: "Passed.", failures: [], criterionCoverage: [] }, completion: { passed: true, summary: "Passed.", failures: [] }, continuation: { passed: true, summary: "Passed.", failures: [] } } };
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      const modelId = String(JSON.parse(String(init?.body)).model);
      models.push(modelId);
      return modelId === "gpt-5.6-luna" ? new Response("unavailable", { status: 503 }) : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(valid) } }] }), { status: 200 });
    };
    try {
      const light = { id: "gpt-5.6-luna", baseUrl: "https://light-audit.test/v1" } as never;
      const main = { id: "gpt-5.6-sol", baseUrl: "https://main-audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model: light, fallbackModel: main, apiKey: "secret", timeoutMs: 1_000 }).reviewSettled({ run, response: "done", operations: [], progress: undefined });
      expect(audit.action).toBe("complete_taskrun");
      expect(models).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("bounds the Supervisor request body and removes redundant contract fields", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "G".repeat(8_000));
    const contract = { sourceInput: "S".repeat(20_000), summary: "summary", objectives: [], acceptanceCriteria: [], scope: "scope", nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "new_task", decisionReason: "D".repeat(10_000), routerVersion: "test" };
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify(contract), run.id);
    store.upsertCheck(run.id, { key: "verify", title: "Verify", status: "passed", required: true, command: "C".repeat(10_000), evidence: "E".repeat(20_000), stale: false });
    store.addArtifact(run.id, { id: "large", title: "Large", kind: "report", content: "A".repeat(20_000), uri: "artifact://large" });
    const valid = { action: "complete_taskrun", reasonCode: "all_gates_passed", rationale: "Complete.", confidence: 1, gates: { progress: { passed: true, summary: "Passed.", failures: [] }, evidence: { passed: true, summary: "Passed.", failures: [] }, contract: { passed: true, summary: "Passed.", failures: [], criterionCoverage: [] }, completion: { passed: true, summary: "Passed.", failures: [] }, continuation: { passed: true, summary: "Passed.", failures: [] } } };
    let requestBody = "";
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => { requestBody = String(init?.body); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(valid) } }] }), { status: 200 }); };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1", maxTokens: 2_048 } as never;
      await new OpenAiSupervisorReviewer({ model, apiKey: "secret" }).reviewSettled({ run: store.getRun(run.id)!, response: "R".repeat(40_000), operations: [], progress: undefined });
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

  it("reviews long candidates with a bounded head-tail projection that preserves the final delivery", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "long delivery");
    const ending = "FINAL DELIVERY: implementation complete; all regression checks passed; no deployment was requested.";
    const response = `Opening context.\n${"middle detail 中文证据。".repeat(2_000)}\n${ending}`;
    const valid = { action: "complete_taskrun", reasonCode: "all_gates_passed", rationale: "Complete.", confidence: 1, gates: { progress: { passed: true, summary: "Passed.", failures: [] }, evidence: { passed: true, summary: "Passed.", failures: [] }, contract: { passed: true, summary: "Passed.", failures: [], criterionCoverage: [] }, completion: { passed: true, summary: "Passed.", failures: [] }, continuation: { passed: true, summary: "Passed.", failures: [] } } };
    let requestBody = "";
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => { requestBody = String(init?.body); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(valid) } }] }), { status: 200 }); };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1", maxTokens: 1_024 } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, apiKey: "secret" }).reviewSettled({ run, response, operations: [], progress: undefined });
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
    const invalid = failedAudit("start_continuation", "final_delivery_truncated", failure);
    const valid = { action: "complete_taskrun", reasonCode: "all_gates_passed", rationale: "The preserved tail contains the complete delivery.", confidence: 1, gates: { progress: { passed: true, summary: "Passed.", failures: [] }, evidence: { passed: true, summary: "Passed.", failures: [] }, contract: { passed: true, summary: "Passed.", failures: [], criterionCoverage: [] }, completion: { passed: true, summary: "Passed.", failures: [] }, continuation: { passed: true, summary: "Passed.", failures: [] } } };
    let requests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { requests += 1; const content = requests === 1 ? invalid : valid; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 }); };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const response = `${"long middle\n".repeat(1_000)}\nFINAL: complete and verified.`;
      const audit = await new OpenAiSupervisorReviewer({ model, apiKey: "secret" }).reviewSettled({ run, response, operations: [], progress: undefined });
      expect(audit.action).toBe("complete_taskrun");
      expect(requests).toBe(2);
      expect(store.getRun(run.id)?.attempt).toBe(1);
      expect(store.getRun(run.id)?.continuations).toHaveLength(0);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("fails closed after bounded review retries when a judge repeatedly confuses projection with output truncation", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "projection loop fuse");
    const failure = { kind: "delivery", key: "candidate_truncated", reason: "The answer is truncated because the middle was omitted.", disposition: "auto_fixable" as const };
    const invalid = failedAudit("start_continuation", "candidate_truncated", failure);
    let requests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { requests += 1; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(invalid) } }] }), { status: 200 }); };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      await expect(new OpenAiSupervisorReviewer({ model, apiKey: "secret" }).reviewSettled({ run, response: `${"detail".repeat(2_000)}\nFINAL complete.`, operations: [], progress: undefined })).rejects.toThrow("bounded review projection");
      expect(requests).toBe(2);
      expect(store.getRun(run.id)?.continuations).toHaveLength(0);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("still allows a genuine model length stop to be classified as truncated", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "real output truncation");
    const failure = { kind: "delivery", key: "final_delivery_truncated", reason: "The model output ended at its length limit.", disposition: "auto_fixable" as const };
    const auditPayload = failedAudit("start_continuation", "final_delivery_truncated", failure);
    let requests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { requests += 1; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(auditPayload) } }] }), { status: 200 }); };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, apiKey: "secret" }).reviewSettled({ run, response: "unfinished ".repeat(1_000), modelOutputTruncated: true, operations: [], progress: undefined });
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
      await expect(new OpenAiSupervisorReviewer({ model: light, fallbackModel: main, apiKey: "secret" }).reviewSettled({ run, response: "done", operations: [], progress: undefined })).rejects.toThrow("API 413");
      expect(models).toEqual(["gpt-5.6-luna"]);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("maps one coverage receipt per criterion by stable id even when the LLM returns them out of order", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "stable coverage mapping");
    const criteria = ["First exact criterion", "Second exact criterion"];
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify({ sourceInput: run.goal, summary: run.goal, objectives: [], acceptanceCriteria: criteria, scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "new_task", decisionReason: "test", routerVersion: "test" }), run.id);
    const valid = { action: "complete_taskrun", reasonCode: "all_gates_passed", rationale: "Complete.", confidence: 1, gates: { progress: { passed: true, summary: "Passed.", failures: [] }, evidence: { passed: true, summary: "Passed.", failures: [] }, contract: { passed: true, summary: "Passed.", failures: [], criterionCoverage: [{ criterionId: "ac-2", status: "covered", evidenceRefs: [], reason: "Second is covered." }, { criterionId: "ac-1", status: "covered", evidenceRefs: [], reason: "First is covered." }] }, completion: { passed: true, summary: "Passed.", failures: [] }, continuation: { passed: true, summary: "Passed.", failures: [] } } };
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(valid) } }] }), { status: 200 });
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, apiKey: "secret" }).reviewSettled({ run: store.getRun(run.id)!, response: "done", operations: [], progress: undefined });
      expect(audit.gates.contract.criterionCoverage?.map((item) => item.criterion)).toEqual(criteria);
      expect(audit.gates.contract.criterionCoverage?.map((item) => item.reason)).toEqual(["First is covered.", "Second is covered."]);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("corrects missing coverage receipts within the bounded Supervisor review attempts", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "correct missing coverage");
    const criteria = ["Criterion one", "Criterion two"];
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify({ sourceInput: run.goal, summary: run.goal, objectives: [], acceptanceCriteria: criteria, scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "new_task", decisionReason: "test", routerVersion: "test" }), run.id);
    const gates = { progress: { passed: true, summary: "Passed.", failures: [] }, evidence: { passed: true, summary: "Passed.", failures: [] }, completion: { passed: true, summary: "Passed.", failures: [] }, continuation: { passed: true, summary: "Passed.", failures: [] } };
    const audit = (criterionCoverage: unknown[]) => ({ action: "complete_taskrun", reasonCode: "all_gates_passed", rationale: "Complete.", confidence: 1, gates: { ...gates, contract: { passed: true, summary: "Passed.", failures: [], criterionCoverage } } });
    let requests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      requests += 1;
      const content = requests === 1
        ? audit([{ criterionId: "ac-1", status: "covered", evidenceRefs: [], reason: "One." }])
        : audit([{ criterionId: "ac-1", status: "covered", evidenceRefs: [], reason: "One." }, { criterionId: "ac-2", status: "covered", evidenceRefs: [], reason: "Two." }]);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
    };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const result = await new OpenAiSupervisorReviewer({ model, apiKey: "secret" }).reviewSettled({ run: store.getRun(run.id)!, response: "done", operations: [], progress: undefined });
      expect(result.gates.contract.criterionCoverage?.map((item) => item.criterion)).toEqual(criteria);
      expect(requests).toBe(2);
      expect(store.getRun(run.id)?.attempt).toBe(1);
      expect(store.getRun(run.id)?.continuations).toHaveLength(0);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("uses a compact delta prompt for Supervisor schema repair", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "compact repair");
    const criterion = "Return a verified explanation";
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify({ sourceInput: run.goal, summary: "S".repeat(1800), objectives: [], acceptanceCriteria: [criterion], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "new_task", decisionReason: "test", routerVersion: "test" }), run.id);
    const gates = { progress: { passed: true, summary: "Passed.", failures: [] }, evidence: { passed: true, summary: "Passed.", failures: [] }, completion: { passed: true, summary: "Passed.", failures: [] }, continuation: { passed: true, summary: "Passed.", failures: [] } };
    const first = { action: "complete_taskrun", reasonCode: "all_gates_passed", rationale: "Complete.", confidence: 1, gates: { ...gates, contract: { passed: true, summary: "Passed.", failures: [], criterionCoverage: [] } } };
    const second = { ...first, gates: { ...gates, contract: { passed: true, summary: "Passed.", failures: [], criterionCoverage: [{ criterionId: "ac-1", status: "covered", evidenceRefs: [], reason: "Covered." }] } } };
    const prompts: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      prompts.push(body.messages[0].content);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(prompts.length === 1 ? first : second) } }] }), { status: 200 });
    };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      await new OpenAiSupervisorReviewer({ model, apiKey: "secret" }).reviewSettled({ run: store.getRun(run.id)!, response: "A complete standalone explanation.", operations: [], progress: undefined });
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("PREVIOUS_RESPONSE=");
      expect(prompts[1]).not.toContain("TASKRUN_DATA=");
      expect(prompts[1].length).toBeLessThan(prompts[0].length);
    } finally { globalThis.fetch = original; store.close(); }
  });

  it("repairs a bounded missing-comma JSON syntax error without rerunning the Agent", async () => {
    const store = new Store(":memory:"); const run = store.createRun(store.createSession().id, "repair malformed audit JSON");
    const valid = { action: "complete_taskrun", reasonCode: "all_gates_passed", rationale: "Complete.", confidence: 1, gates: { progress: { passed: true, summary: "Passed.", failures: [] }, evidence: { passed: true, summary: "Passed.", failures: [] }, contract: { passed: true, summary: "Passed.", failures: [], criterionCoverage: [] }, completion: { passed: true, summary: "Passed.", failures: [] }, continuation: { passed: true, summary: "Passed.", failures: [] } } };
    const malformed = JSON.stringify(valid).replace('"reasonCode"', '"reasonCode"').replace(',"confidence"', '"confidence"');
    let requests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { requests += 1; return new Response(JSON.stringify({ choices: [{ message: { content: malformed } }] }), { status: 200 }); };
    try {
      const model = { id: "audit-model", baseUrl: "https://audit.test/v1" } as never;
      const audit = await new OpenAiSupervisorReviewer({ model, apiKey: "secret" }).reviewSettled({ run, response: "done", operations: [], progress: undefined });
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
      await expect(new OpenAiSupervisorReviewer({ model, apiKey: "secret" }).reviewSettled({ run, response: "done", operations: [], progress: undefined })).rejects.toThrow("after 2 review attempts");
      expect(requests).toBe(2);
      expect(store.getRun(run.id)?.attempt).toBe(1);
      expect(store.getRun(run.id)?.continuations).toHaveLength(0);
    } finally { globalThis.fetch = original; store.close(); }
  });

});
