import { afterEach, describe, expect, it, vi } from "vitest";
import { LearningService, WorkflowLearningService } from "@tagent/learning";
import {
  decodeIntegrationLearningProjection,
  type IntegrationLearningProjectionRecord,
} from "@tagent/learning/domain";
import type { RecallFeedbackSignal } from "@tagent/memory/domain";
import { Store } from "@tagent/persistence-sqlite";
import { createExecutionCollaborationAdapters } from "../apps/core-service/src/composition/execution-collaboration-adapters.js";
import { agentPersistence, learningPersistence, workflowPersistence } from "./support/test-persistence.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

function completedRun(store: Store, sessionId: string) {
  const run = store.createRun(sessionId, "implement durable learning ledger");
  store.upsertPlanItem(run.id, { key: "implement", title: "Implement", status: "done", required: true, position: 1 });
  store.upsertCheck(run.id, { key: "tests", title: "Tests", status: "passed", required: true, command: "npm test", evidence: "passed", stale: false });
  store.transitionRun(run.id, ["running"], "completed", "run.completed", {}, "", 1);
  return store.getRun(run.id)!;
}

describe("Communication Profile", () => {
  it("activates explicit preferences immediately and inferred preferences only after repeated evidence", () => {
    const store = new Store(":memory:"); stores.push(store); const learning = new LearningService(learningPersistence(store));
    learning.recordCommunicationPreference({ subjectId: "user:1", scopeType: "global", scopeId: "*", dimension: "language", value: "中文", sourceType: "explicit_user", sourceRef: "message:1" });
    learning.recordCommunicationPreference({ subjectId: "user:1", scopeType: "session", scopeId: "s1", dimension: "verbosity", value: "简洁", sourceType: "inferred", sourceRef: "run:r1" });
    let resolved = learning.resolveCommunicationProfile("user:1", [{ type: "session", id: "s1" }]);
    expect(resolved.values.language).toMatchObject({ value: "中文", status: "active" });
    expect(resolved.values.verbosity).toBeUndefined();
    learning.recordCommunicationPreference({ subjectId: "user:1", scopeType: "session", scopeId: "s1", dimension: "verbosity", value: "简洁", sourceType: "inferred", sourceRef: "run:r2" });
    resolved = learning.resolveCommunicationProfile("user:1", [{ type: "session", id: "s1" }]);
    expect(resolved.values.verbosity).toMatchObject({ value: "简洁", status: "active", confirmations: 2 });
    expect(resolved.promptSection).toContain("language: 中文");
  });

  it("extracts explicit user communication instructions and supports profile locking", () => {
    const store = new Store(":memory:"); stores.push(store); const learning = new LearningService(learningPersistence(store));
    learning.captureExplicitCommunicationPreferences("session:s1", "s1", 12, "以后用中文回答，请简洁");
    const profiles = learning.listCommunicationProfiles("session:s1");
    expect(profiles[0]?.revision?.values.language?.value).toBe("中文");
    learning.lockCommunicationProfile(profiles[0]!.id, true);
    learning.recordCommunicationPreference({ subjectId: "session:s1", scopeType: "session", scopeId: "s1", dimension: "language", value: "英文", sourceType: "inferred", sourceRef: "run:x" });
    expect(learning.resolveCommunicationProfile("session:s1", [{ type: "session", id: "s1" }]).values.language?.value).toBe("中文");
  });

  it("shares principal-owned global habits across Workspaces and retains Session overrides", async () => {
    const store = new Store(":memory:"); stores.push(store);
    const first = store.createSessionIdempotent({ title: "First", principalId: "user:1", idempotencyKey: "first", canonicalPayload: "first" }).session;
    const second = store.createSessionIdempotent({ title: "Second", principalId: "user:1", idempotencyKey: "second", canonicalPayload: "second" }).session;
    const persistence = agentPersistence(store);
    const learning = new LearningService(learningPersistence(store));
    const workflows = new WorkflowLearningService(workflowPersistence(store));
    const captureRequests: any[] = [];
    const adapters = createExecutionCollaborationAdapters({
      persistence,
      memory: { enqueueCapture: async (request: unknown) => { captureRequests.push(request); return { jobId: "capture" }; } } as never,
      memoryScopeId: "default",
      learningService: learning,
      workflowService: workflows,
      publish: () => undefined,
    });
    const firstRun = store.createRun(first.id, "first task");
    const secondRun = store.createRun(second.id, "second task");
    const message = store.appendMessage(first.id, "user", "以后回答短一些，只说重点");

    adapters.userMessageObserver.observe({ run: firstRun, messageId: message.id, content: message.content, context: "" });
    await vi.waitFor(() => expect(store.db.prepare("SELECT status FROM semantic_learning_jobs").get()).toEqual({ status: "completed" }));
    expect(captureRequests[0].access).toMatchObject({ subjectId: "user:1", purpose: "capture" });
    expect(captureRequests[0].access.scopes).toEqual(expect.arrayContaining([{ type: "user", id: "user:1" }, { type: "workspace", id: "default" }]));
    expect(persistence.submissions.getSessionPrincipalId?.(first.id)).toBe("user:1");
    expect(adapters.contextEnrichment.prepareWithoutRecall(secondRun, "unrelated task").promptSection).toContain("verbosity: 简洁");

    const oneOff = store.appendMessage(first.id, "user", "请详细解释这一次变更");
    adapters.userMessageObserver.observe({ run: firstRun, messageId: oneOff.id, content: oneOff.content, context: "" });
    await vi.waitFor(() => expect(store.db.prepare("SELECT COUNT(*) AS count FROM semantic_learning_jobs WHERE status='completed'").get()).toEqual({ count: 2 }));
    expect(adapters.contextEnrichment.prepareWithoutRecall(firstRun, "current task").promptSection).toContain("verbosity: 详细");
    expect(adapters.contextEnrichment.prepareWithoutRecall(secondRun, "unrelated task").promptSection).toContain("verbosity: 简洁");

    learning.recordCommunicationPreference({ subjectId: `session:${second.id}`, scopeType: "session", scopeId: second.id, dimension: "language", value: "中文", sourceType: "explicit_user", sourceRef: "session-override" });
    expect(adapters.contextEnrichment.prepareWithoutRecall(secondRun, "unrelated task").promptSection).toContain("language: 中文");
  });
});

describe("Learning Event, Outcome Label, and Correction ledgers", () => {
  it("projects immutable learning events and outcome labels idempotently", () => {
    const store = new Store(":memory:"); stores.push(store); const session = store.createSession(); const learning = new LearningService(learningPersistence(store)); const run = completedRun(store, session.id);
    learning.projectRun(run); learning.projectRun(run);
    expect((store.db.prepare("SELECT COUNT(*) count FROM learning_events WHERE run_id=?").get(run.id) as { count: number }).count).toBe(1);
    expect((store.db.prepare("SELECT COUNT(*) count FROM outcome_labels WHERE run_id=?").get(run.id) as { count: number }).count).toBe(5);
    const event = learning.listLearningEvents(session.id)[0];
    expect(event.outcome).toMatchObject({ status: "completed", success: true, requiredChecks: 1 });
    expect(event.executionTrace).toHaveProperty("continuations");
  });

  it("replays each integration lifecycle into the generic ledger idempotently", () => {
    const store = new Store(":memory:"); stores.push(store); const session = store.createSession(); const learning = new LearningService(learningPersistence(store)); const run = store.createRun(session.id, "wait for user input");
    store.requestUserInput(run.id, "Need value", [{ key: "v", label: "Value", description: "", inputType: "text", required: true, placeholder: "" }]);
    const record = store.db.prepare(`SELECT outbox_sequence as outboxSequence,
      source_event_id as sourceEventId,payload_hash as payloadHash,aggregate_id as aggregateId,
      aggregate_version as aggregateVersion,run_event_ref as runEventRef,attempt_id as attemptId,
      attempt_ordinal as attemptOrdinal,payload_json as payloadJson,
      evidence_snapshot_json as evidenceSnapshotJson FROM integration_outbox`).get() as
      IntegrationLearningProjectionRecord;
    const projection = decodeIntegrationLearningProjection(record);
    learning.applyActiveProjection(projection); learning.applyActiveProjection(projection);
    const events = learning.listLearningEvents(session.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ lifecycle: "run.waiting_input", outcome: { status: "waiting_input", success: false } });
  });

  it("records user corrections idempotently and labels correction on the run", () => {
    const store = new Store(":memory:"); stores.push(store); const session = store.createSession(); const learning = new LearningService(learningPersistence(store)); const run = completedRun(store, session.id);
    const message = store.appendMessage(session.id, "user", "不对，应该改为保守归因");
    learning.recordCorrection({ sessionId: session.id, runId: run.id, attempt: run.attempt, messageId: message.id, content: message.content });
    learning.recordCorrection({ sessionId: session.id, runId: run.id, attempt: run.attempt, messageId: message.id, content: message.content });
    learning.projectRun(store.getRun(run.id)!);
    expect(learning.listCorrections(session.id)).toHaveLength(1);
    expect(store.db.prepare("SELECT value FROM outcome_labels WHERE run_id=? AND label='correction_observed'").get(run.id)).toEqual({ value: "true" });
  });
});

describe("conservative automatic Feedback Attribution", () => {
  it("only attributes cited records and does not treat every recalled record as task_success", async () => {
    const store = new Store(":memory:"); stores.push(store); const session = store.createSession(); const calls: Array<{ recordId: string; signal: RecallFeedbackSignal }> = [];
    const memory = { feedback: async (_access: unknown, _scope: unknown, recordId: string, signal: RecallFeedbackSignal) => { calls.push({ recordId, signal }); return { id: `${recordId}:${signal}` }; } } as never;
    const learning = new LearningService(learningPersistence(store), memory, "workspace-1"); const run = completedRun(store, session.id);
    store.recordContextManifest({ id: "manifest-1", runId: run.id, attempt: 1, source: "session", manifestHash: "h", createdAt: Date.now(), stats: {}, items: [
      { kind: "memory_card", sourceId: "memory-a", selected: true, reason: "recall", estimatedTokens: 2 },
      { kind: "memory_card", sourceId: "memory-b", selected: true, reason: "recall", estimatedTokens: 2 },
    ] });
    store.appendMessage(session.id, "assistant", "Result based on [memory:memory-a].");
    learning.projectRun(store.getRun(run.id)!);
    const receipts = learning.listFeedbackAttribution(session.id) as Array<{ recordId: string; signal: string; status: string }>;
    expect(receipts.map((item) => `${item.recordId}:${item.signal}`).sort()).toEqual(["memory-a:cited", "memory-a:task_success"]);
    await learning.drainFeedbackAttribution(); await learning.drainFeedbackAttribution();
    expect(calls.map((item) => `${item.recordId}:${item.signal}`).sort()).toEqual(["memory-a:cited", "memory-a:task_success"]);
    expect(learning.listFeedbackAttribution(session.id).every((item: any) => item.status === "applied")).toBe(true);
  });


  it("retries transient feedback failures and dead-letters the fifth failure", async () => {
    const store = new Store(":memory:"); stores.push(store); const session = store.createSession(); let calls = 0;
    const memory = { feedback: async () => { calls++; throw new Error("temporary backend outage"); } } as never;
    const learning = new LearningService(learningPersistence(store), memory, "workspace-1"); const run = completedRun(store, session.id);
    store.recordContextManifest({ id: "manifest-retry", runId: run.id, attempt: 1, source: "session", manifestHash: "retry", createdAt: Date.now(), stats: {}, items: [{ kind: "memory_card", sourceId: "memory-retry", selected: true, reason: "recall", estimatedTokens: 1 }] });
    store.appendMessage(session.id, "assistant", "[memory:memory-retry]"); learning.projectRun(store.getRun(run.id)!);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      store.db.prepare("UPDATE feedback_attribution_receipts SET next_retry_at=0 WHERE status IN ('pending','failed')").run();
      await learning.drainFeedbackAttribution();
      const rows = learning.listFeedbackAttribution(session.id) as Array<{ status: string; attempts: number }>;
      expect(rows.every((row) => row.attempts === attempt)).toBe(true);
      expect(rows.every((row) => row.status === (attempt === 5 ? "dead_letter" : "failed"))).toBe(true);
    }
    expect(calls).toBe(10);
  });

  it("withholds positive attribution when required checks are absent", () => {
    const store = new Store(":memory:"); stores.push(store); const session = store.createSession(); const learning = new LearningService(learningPersistence(store)); const run = store.createRun(session.id, "unchecked");
    store.transitionRun(run.id, ["running"], "completed", "run.completed", {}, "", 1);
    store.recordContextManifest({ id: "manifest-2", runId: run.id, attempt: 1, source: "session", manifestHash: "h2", createdAt: Date.now(), stats: {}, items: [{ kind: "memory_card", sourceId: "memory-a", selected: true, reason: "recall", estimatedTokens: 2 }] });
    store.appendMessage(session.id, "assistant", "[memory:memory-a]");
    learning.projectRun(store.getRun(run.id)!);
    expect((learning.listFeedbackAttribution(session.id) as Array<{ signal: string }>).map((item) => item.signal)).toEqual(["cited"]);
    expect(learning.listLearningEvents(session.id)[0]?.outcome).toMatchObject({ success: false });
  });
});
