import { afterEach, describe, expect, it } from "vitest";
import { WorkflowLearningService } from "@tagent/learning";
import {
  decodeIntegrationLearningProjection,
  type IntegrationLearningProjectionRecord,
} from "@tagent/learning/domain";
import { Store } from "@tagent/persistence-sqlite/store";
import { corePersistence } from "./support/test-persistence.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

function projections(store: Store): IntegrationLearningProjectionRecord[] {
  return store.db.prepare(`SELECT outbox_sequence as outboxSequence,
    source_event_id as sourceEventId,payload_hash as payloadHash,aggregate_id as aggregateId,
    aggregate_version as aggregateVersion,run_event_ref as runEventRef,attempt_id as attemptId,
    attempt_ordinal as attemptOrdinal,payload_json as payloadJson,
    evidence_snapshot_json as evidenceSnapshotJson FROM integration_outbox ORDER BY outbox_sequence`)
    .all() as IntegrationLearningProjectionRecord[];
}

function projectAll(store: Store, service: WorkflowLearningService): void {
  for (const record of projections(store)) service.applyActiveProjection(decodeIntegrationLearningProjection(record));
}

describe("Learning boundary matrix", () => {
  it.each([
    ["run.completed", "completed"],
    ["run.blocked", "blocked"],
    ["run.cancelled", "cancelled"],
    ["run.failed", "failed"],
  ] as const)("projects %s idempotently", (lifecycle, outcome) => {
    const store = new Store(":memory:"); stores.push(store);
    const service = new WorkflowLearningService(corePersistence(store).workflow);
    const session = store.createSession();
    const run = store.createRun(session.id, lifecycle);
    store.transitionRun(run.id, ["running"], outcome, lifecycle, { reason: lifecycle }, lifecycle, 1);
    projectAll(store, service); projectAll(store, service);
    expect(store.db.prepare(`SELECT lifecycle,outcome,COUNT(*) count
      FROM experience_observations WHERE run_id=?`).get(run.id))
      .toEqual({ lifecycle, outcome, count: 1 });
  });

  it("projects the immutable Attempt snapshot after the Run advances", () => {
    const store = new Store(":memory:"); stores.push(store);
    const session = store.createSession();
    const run = store.createRun(session.id, "attempt snapshot");
    store.upsertPlanItem(run.id, {
      key: "attempt-one", title: "Attempt one step", status: "done", required: true, position: 1,
    });
    store.upsertCheck(run.id, {
      key: "attempt-one-check", title: "Attempt one check", status: "passed", required: true,
      command: "", evidence: "fresh", stale: false,
    });
    store.recordModelUsage(run.id, "agent", "attempt-one-model", {
      input: 10, output: 5, totalTokens: 15, cost: 0.1,
    });
    store.recordContextManifest({
      id: "manifest-a1", runId: run.id, attempt: 1, source: "session",
      items: [{ kind: "workflow_revision", sourceId: "revision-a1", selected: true, reason: "attempt one", estimatedTokens: 1 }],
      stats: {}, manifestHash: "hash-a1", createdAt: 1,
    });
    store.transitionRun(run.id, ["running"], "completed", "run.completed", {}, "", 1);

    store.db.prepare("UPDATE runs SET status='running',attempt=2,completed_at=NULL WHERE id=?").run(run.id);
    store.upsertPlanItem(run.id, {
      key: "attempt-two", title: "Attempt two step", status: "done", required: true, position: 2,
    });
    store.upsertCheck(run.id, {
      key: "attempt-one-check", title: "Attempt one check", status: "failed", required: true,
      command: "", evidence: "changed", stale: false,
    });

    const record = projections(store)[0]!;
    const projection = decodeIntegrationLearningProjection(record);
    const snapshot = projection.taskRunSnapshot as Record<string, any>;
    expect(snapshot).toMatchObject({
      attempt: 1,
      status: "completed",
      usage: { input: 10, output: 5, totalTokens: 15, cost: 0.1 },
    });
    expect(snapshot.supervision.latestContextManifest.id).toBe("manifest-a1");
    expect(snapshot.plan.map((item: any) => item.key)).toEqual(["attempt-one"]);
    expect(snapshot.checks).toEqual([
      expect.objectContaining({ key: "attempt-one-check", status: "passed", evidence: "fresh" }),
    ]);

    const service = new WorkflowLearningService(corePersistence(store).workflow);
    service.applyActiveProjection(projection);
    const observation = store.db.prepare(`SELECT procedure_summary as summary,
      checks_passed_json as checks FROM experience_observations WHERE run_id=? AND attempt=1`)
      .get(run.id) as { summary: string; checks: string };
    expect(observation.summary).toContain("Attempt one step");
    expect(observation.summary).not.toContain("Attempt two step");
    expect(JSON.parse(observation.checks)).toEqual(["attempt-one-check"]);
  });

  it("projects waiting_input and restart interruption", () => {
    const store = new Store(":memory:"); stores.push(store);
    const session = store.createSession();
    const waiting = store.createRun(session.id, "wait");
    store.requestUserInput(waiting.id, "need value", [{
      key: "v", label: "Value", description: "", inputType: "text", required: true, placeholder: "",
    }]);
    const interrupted = store.createRun(session.id, "interrupt");
    store.markInterrupted();
    const service = new WorkflowLearningService(corePersistence(store).workflow);
    projectAll(store, service);
    expect(store.db.prepare("SELECT lifecycle FROM experience_observations WHERE run_id=?").get(waiting.id))
      .toEqual({ lifecycle: "run.waiting_input" });
    expect(store.db.prepare("SELECT lifecycle FROM experience_observations WHERE run_id=?").get(interrupted.id))
      .toEqual({ lifecycle: "restart.interruption" });
  });
});
