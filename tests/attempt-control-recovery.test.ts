import { afterEach, describe, expect, it } from "vitest";
import { ATTEMPT_AUTHORITY_SCENARIOS } from "@tagent/execution/domain";
import type { ShadowComparisonInput } from "@tagent/execution/ports";
import { LegacyStoreAdapter, Store } from "@tagent/persistence-sqlite";
import type { SynchronousResult } from "@tagent/persistence-sqlite/unit-of-work";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  const adapter = new LegacyStoreAdapter(store, { run<T>(work: () => T & SynchronousResult<T>): T { return store.db.transaction(work)(); } });
  const session = adapter.sessions.createSession();
  const run = adapter.taskRuns.createRun(session.id, "authority gate");
  return { store, adapter, attempt: adapter.attempts.getActiveAttempt(run.id)! };
}

function samples(attemptId: string, count: number, options: { mismatchAt?: number; omitScenario?: string } = {}): ShadowComparisonInput[] {
  const scenarios = ATTEMPT_AUTHORITY_SCENARIOS.filter((scenario) => scenario !== options.omitScenario);
  return Array.from({ length: count }, (_, index) => ({
    attemptId, scenario: scenarios[index % scenarios.length],
    legacy: { status: "running" }, projected: { status: index === options.mismatchAt ? "blocked" : "running" },
    mismatch: index === options.mismatchAt,
  }));
}

describe("Attempt authority gate", () => {
  it("defaults to shadow/blocked and requires 1000 comparisons, zero mismatches, and full scenario coverage", () => {
    const { adapter, attempt } = fixture();
    expect(adapter.attemptAuthority.getAuthorityState()).toMatchObject({ mode: "shadow", status: "blocked", approvedAttemptId: null });

    adapter.attemptAuthority.recordShadowComparisons(samples(attempt.id, 999));
    expect(adapter.attemptAuthority.evaluateAuthorityGate()).toMatchObject({ eligible: false, sampleCount: 999, mismatchCount: 0 });
    adapter.attemptAuthority.recordShadowComparisons(samples(attempt.id, 1));
    expect(adapter.attemptAuthority.evaluateAuthorityGate()).toMatchObject({ eligible: true, sampleCount: 1_000, mismatchCount: 0, missingScenarios: [] });
  });

  it("blocks mismatches, missing scenarios, and authority requests without an explicit approving receipt", () => {
    const mismatch = fixture();
    mismatch.adapter.attemptAuthority.recordShadowComparisons(samples(mismatch.attempt.id, 1_000, { mismatchAt: 500 }));
    expect(mismatch.adapter.attemptAuthority.evaluateAuthorityGate()).toMatchObject({ eligible: false, mismatchCount: 1 });

    const coverage = fixture();
    coverage.adapter.attemptAuthority.recordShadowComparisons(samples(coverage.attempt.id, 1_000, { omitScenario: "terminal" }));
    expect(coverage.adapter.attemptAuthority.evaluateAuthorityGate()).toMatchObject({ eligible: false, missingScenarios: ["terminal"] });

    const receipt = fixture();
    receipt.adapter.attemptAuthority.recordShadowComparisons(samples(receipt.attempt.id, 1_000));
    expect(() => receipt.adapter.attemptAuthority.requestAuthority({ requestedAttemptId: receipt.attempt.id, receiptId: "missing" })).toThrow(/receipt/);
    receipt.adapter.attemptAuthority.recordAuthorityReceipt({ id: "rejected", requestedAttemptId: receipt.attempt.id, decision: "rejected", actor: "governor", reason: "not approved" });
    expect(() => receipt.adapter.attemptAuthority.requestAuthority({ requestedAttemptId: receipt.attempt.id, receiptId: "rejected" })).toThrow(/approved/);
  });

  it("canonicalizes comparison payloads and never trusts the caller mismatch flag", () => {
    const different = fixture();
    different.adapter.attemptAuthority.recordShadowComparisons([{
      attemptId: different.attempt.id,
      scenario: "initial",
      legacy: { nested: { b: 2, a: 1 } },
      projected: { nested: { a: 1, b: 3 } },
      mismatch: false,
    }]);
    expect(different.adapter.attemptAuthority.evaluateAuthorityGate()).toMatchObject({ mismatchCount: 1 });

    const same = fixture();
    same.adapter.attemptAuthority.recordShadowComparisons([{
      attemptId: same.attempt.id,
      scenario: "initial",
      legacy: { nested: { b: 2, a: 1 } },
      projected: { nested: { a: 1, b: 2 } },
      mismatch: true,
    }]);
    expect(same.adapter.attemptAuthority.evaluateAuthorityGate()).toMatchObject({ mismatchCount: 0 });
  });

  it("requires an explicit Governance reset before opening a new clean comparison epoch", () => {
    const { adapter, attempt } = fixture();
    adapter.attemptAuthority.recordShadowComparisons(samples(attempt.id, 1, { mismatchAt: 0 }));
    adapter.attemptAuthority.recordShadowComparisons(samples(attempt.id, 1_000));
    expect(adapter.attemptAuthority.evaluateAuthorityGate()).toMatchObject({
      eligible: false,
      sampleCount: 1_001,
      mismatchCount: 1,
      lastMismatchId: expect.any(String),
    });

    const reset = adapter.attemptAuthority.recordAuthorityReceipt({
      id: "reset-after-mismatch",
      requestedAttemptId: attempt.id,
      decision: "rollback",
      actor: "release-governor",
      reason: "open a clean comparison epoch",
    });
    expect(adapter.attemptAuthority.rollbackAuthority({ receiptId: reset.id })).toMatchObject({
      mode: "shadow",
      status: "blocked",
      sampleCount: 0,
      mismatchCount: 0,
      scenarioCoverage: [],
      comparisonEpochStart: expect.any(Number),
      lastMismatchId: null,
    });
    expect(adapter.attemptAuthority.evaluateAuthorityGate()).toMatchObject({
      eligible: false,
      sampleCount: 0,
      mismatchCount: 0,
    });

    adapter.attemptAuthority.recordShadowComparisons(samples(attempt.id, 1_000));
    expect(adapter.attemptAuthority.evaluateAuthorityGate()).toMatchObject({
      eligible: true,
      sampleCount: 1_000,
      mismatchCount: 0,
      missingScenarios: [],
    });
    const approval = adapter.attemptAuthority.recordAuthorityReceipt({
      id: "reapprove-after-clean-epoch",
      requestedAttemptId: attempt.id,
      decision: "approved",
      actor: "release-governor",
      reason: "new epoch is clean",
    });
    expect(adapter.attemptAuthority.requestAuthority({
      requestedAttemptId: attempt.id,
      receiptId: approval.id,
    })).toMatchObject({
      mode: "canary",
      status: "approved",
      approvedAttemptId: attempt.id,
      sampleCount: 1_000,
      mismatchCount: 0,
    });
  });

  it("approves only the requested Attempt and rollback changes mode without lowering schema", () => {
    const { store, adapter, attempt } = fixture();
    const another = adapter.taskRuns.createRun(adapter.sessions.createSession().id, "not approved");
    const otherAttempt = adapter.attempts.getActiveAttempt(another.id)!;
    adapter.attemptAuthority.recordShadowComparisons(samples(attempt.id, 1_000));
    adapter.attemptAuthority.recordAuthorityReceipt({ id: "approved", requestedAttemptId: attempt.id, decision: "approved", actor: "release-governor", reason: "gate passed" });
    expect(adapter.attemptAuthority.requestAuthority({ requestedAttemptId: attempt.id, receiptId: "approved" })).toMatchObject({
      mode: "canary", status: "approved", approvedAttemptId: attempt.id,
      comparisonWatermark: expect.any(Number), lastMismatchId: null,
    });
    expect(() => adapter.attemptAuthority.assertAttemptApproved(otherAttempt.id)).toThrow(/not approved/);

    adapter.attemptAuthority.recordAuthorityReceipt({ id: "rollback", requestedAttemptId: attempt.id, decision: "rollback", actor: "release-governor", reason: "rollback authority only" });
    expect(adapter.attemptAuthority.rollbackAuthority({ receiptId: "rollback" })).toMatchObject({ mode: "shadow", status: "blocked", approvedAttemptId: null });
    expect(store.getSchemaVersion()).toBe(46);
  });
});
