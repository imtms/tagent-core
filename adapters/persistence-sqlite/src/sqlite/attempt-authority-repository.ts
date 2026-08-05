import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  ATTEMPT_AUTHORITY_SCENARIOS,
  type AttemptAuthorityGate,
  type AttemptAuthorityReceipt,
  type AttemptAuthorityScenario,
  type AttemptAuthorityState,
  type AttemptShadowComparison,
} from "@tagent/execution/domain";
import type {
  AttemptAuthorityRepository,
  ShadowComparisonInput,
} from "@tagent/execution/ports";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function parseScenarios(value: string): AttemptAuthorityScenario[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return [];
  const known = new Set<string>(ATTEMPT_AUTHORITY_SCENARIOS);
  return parsed.filter((item): item is AttemptAuthorityScenario => typeof item === "string" && known.has(item));
}

export class SqliteAttemptAuthorityRepository implements AttemptAuthorityRepository {
  constructor(private readonly db: Database.Database) {}

  getAuthorityState(): AttemptAuthorityState {
    const row = this.db.prepare(`SELECT mode,status,approved_attempt_id as approvedAttemptId,
      receipt_id as receiptId,sample_count as sampleCount,mismatch_count as mismatchCount,
      scenario_coverage_json as scenarioCoverageJson,comparison_epoch_start as comparisonEpochStart,
      comparison_watermark as comparisonWatermark,
      last_mismatch_id as lastMismatchId,updated_at as updatedAt
      FROM attempt_authority_state WHERE id=1`).get() as {
        mode: AttemptAuthorityState["mode"];
        status: AttemptAuthorityState["status"];
        approvedAttemptId: AttemptAuthorityState["approvedAttemptId"];
        receiptId: string | null;
        sampleCount: number;
        mismatchCount: number;
        scenarioCoverageJson: string;
        comparisonEpochStart: number;
        comparisonWatermark: number;
        lastMismatchId: string | null;
        updatedAt: number;
      } | undefined;
    if (!row) throw new Error("Attempt authority state is not initialized");
    const { scenarioCoverageJson, ...state } = row;
    return { ...state, scenarioCoverage: parseScenarios(scenarioCoverageJson) };
  }

  evaluateAuthorityGate(): AttemptAuthorityGate {
    const { comparisonEpochStart } = this.getAuthorityState();
    const aggregate = this.db.prepare(`SELECT COUNT(*) as sampleCount,
      COALESCE(SUM(mismatch),0) as mismatchCount,COALESCE(MAX(rowid),0) as comparisonWatermark
      FROM attempt_shadow_comparisons WHERE gate_sample=1 AND rowid>?`).get(comparisonEpochStart) as {
        sampleCount: number;
        mismatchCount: number;
        comparisonWatermark: number;
      };
    const coverageRows = this.db.prepare(`SELECT DISTINCT scenario FROM attempt_shadow_comparisons
      WHERE gate_sample=1 AND rowid>? ORDER BY scenario`).all(comparisonEpochStart) as Array<{ scenario: AttemptAuthorityScenario }>;
    const scenarioCoverage = coverageRows.map((row) => row.scenario)
      .filter((scenario) => ATTEMPT_AUTHORITY_SCENARIOS.includes(scenario));
    const missingScenarios = ATTEMPT_AUTHORITY_SCENARIOS.filter((scenario) => !scenarioCoverage.includes(scenario));
    const mismatch = this.db.prepare(`SELECT id FROM attempt_shadow_comparisons
      WHERE gate_sample=1 AND mismatch=1 AND rowid>? ORDER BY rowid DESC LIMIT 1`).get(comparisonEpochStart) as { id: string } | undefined;
    const reasons: string[] = [];
    if (aggregate.sampleCount < 1_000) reasons.push("At least 1000 canonical shadow comparisons are required");
    if (aggregate.mismatchCount > 0) reasons.push("Shadow comparison mismatches must be zero");
    if (missingScenarios.length > 0) reasons.push(`Missing scenario coverage: ${missingScenarios.join(", ")}`);
    return {
      eligible: reasons.length === 0,
      sampleCount: aggregate.sampleCount,
      mismatchCount: aggregate.mismatchCount,
      scenarioCoverage,
      missingScenarios: [...missingScenarios],
      comparisonWatermark: Math.max(comparisonEpochStart, aggregate.comparisonWatermark),
      lastMismatchId: mismatch?.id ?? null,
      reasons,
    };
  }

  recordShadowComparisons(inputs: ShadowComparisonInput[]): AttemptShadowComparison[] {
    return this.db.transaction(() => {
      const timestamp = Date.now();
      const recorded = inputs.map((input) => {
        if (!this.db.prepare("SELECT 1 FROM attempts WHERE id=?").get(input.attemptId)) {
          throw new Error(`Attempt ${input.attemptId} does not exist`);
        }
        const legacyJson = canonicalJson(input.legacy);
        const projectedJson = canonicalJson(input.projected);
        const comparison: AttemptShadowComparison = {
          id: randomUUID(),
          attemptId: input.attemptId as AttemptShadowComparison["attemptId"],
          scenario: input.scenario,
          legacy: JSON.parse(legacyJson) as Record<string, unknown>,
          projected: JSON.parse(projectedJson) as Record<string, unknown>,
          mismatch: legacyJson !== projectedJson,
          createdAt: input.createdAt ?? timestamp,
        };
        this.db.prepare(`INSERT INTO attempt_shadow_comparisons
          (id,attempt_id,scenario,legacy_json,projected_json,mismatch,gate_sample,created_at)
          VALUES (?,?,?,?,?,?,1,?)`).run(
          comparison.id, comparison.attemptId, comparison.scenario, legacyJson, projectedJson,
          Number(comparison.mismatch), comparison.createdAt,
        );
        return comparison;
      });
      if (recorded.some((comparison) => comparison.mismatch)) {
        const gate = this.evaluateAuthorityGate();
        this.db.prepare(`UPDATE attempt_authority_state SET mode='shadow',status='blocked',
          approved_attempt_id=NULL,receipt_id=NULL,sample_count=?,mismatch_count=?,
          scenario_coverage_json=?,comparison_watermark=?,last_mismatch_id=?,updated_at=? WHERE id=1`)
          .run(
            gate.sampleCount, gate.mismatchCount, JSON.stringify(gate.scenarioCoverage),
            gate.comparisonWatermark, gate.lastMismatchId, timestamp,
          );
      }
      return recorded;
    })();
  }

  recordAuthorityReceipt(input: {
    id: string;
    requestedAttemptId: string;
    decision: AttemptAuthorityReceipt["decision"];
    actor: string;
    reason: string;
    createdAt?: number;
  }): AttemptAuthorityReceipt {
    const receipt: AttemptAuthorityReceipt = {
      id: input.id,
      requestedAttemptId: input.requestedAttemptId as AttemptAuthorityReceipt["requestedAttemptId"],
      decision: input.decision,
      actor: input.actor.trim(),
      reason: input.reason.trim(),
      createdAt: input.createdAt ?? Date.now(),
    };
    if (!receipt.actor || !receipt.reason) throw new TypeError("Authority receipt actor and reason are required");
    this.db.prepare(`INSERT OR IGNORE INTO attempt_authority_receipts
      (id,requested_attempt_id,decision,actor,reason,created_at) VALUES (?,?,?,?,?,?)`).run(
      receipt.id, receipt.requestedAttemptId, receipt.decision, receipt.actor, receipt.reason, receipt.createdAt,
    );
    const stored = this.getReceipt(receipt.id);
    if (!stored || canonicalJson(stored) !== canonicalJson(receipt)) {
      throw new Error(`Authority receipt ${receipt.id} already exists with different content`);
    }
    return stored;
  }

  requestAuthority(input: { requestedAttemptId: string; receiptId: string; timestamp?: number }): AttemptAuthorityState {
    return this.db.transaction(() => {
      const receipt = this.getReceipt(input.receiptId);
      if (!receipt) throw new Error(`Authority receipt ${input.receiptId} does not exist`);
      if (receipt.decision !== "approved") throw new Error(`Authority receipt ${input.receiptId} is not approved`);
      if (receipt.requestedAttemptId !== input.requestedAttemptId) {
        throw new Error("Authority receipt requested Attempt does not match");
      }
      if (!this.db.prepare("SELECT 1 FROM attempts WHERE id=?").get(input.requestedAttemptId)) {
        throw new Error(`Attempt ${input.requestedAttemptId} does not exist`);
      }
      const gate = this.evaluateAuthorityGate();
      if (!gate.eligible) throw new Error(`Attempt authority gate is blocked: ${gate.reasons.join("; ")}`);
      const timestamp = input.timestamp ?? Date.now();
      this.db.prepare(`UPDATE attempt_authority_state SET mode='canary',status='approved',
        approved_attempt_id=?,receipt_id=?,sample_count=?,mismatch_count=?,scenario_coverage_json=?,
        comparison_watermark=?,last_mismatch_id=?,updated_at=? WHERE id=1`).run(
        input.requestedAttemptId, input.receiptId, gate.sampleCount, gate.mismatchCount,
        JSON.stringify(gate.scenarioCoverage), gate.comparisonWatermark, gate.lastMismatchId, timestamp,
      );
      return this.getAuthorityState();
    })();
  }

  assertAttemptApproved(attemptId: string): void {
    const state = this.getAuthorityState();
    if (state.mode !== "canary" || state.status !== "approved" || state.approvedAttemptId !== attemptId) {
      throw new Error(`Attempt ${attemptId} is not approved for canary execution`);
    }
  }

  rollbackAuthority(input: { receiptId: string; timestamp?: number }): AttemptAuthorityState {
    return this.db.transaction(() => {
      const state = this.getAuthorityState();
      const receipt = this.getReceipt(input.receiptId);
      if (!receipt) throw new Error(`Authority receipt ${input.receiptId} does not exist`);
      if (receipt.decision !== "rollback") throw new Error(`Authority receipt ${input.receiptId} is not a rollback receipt`);
      if (state.approvedAttemptId && receipt.requestedAttemptId !== state.approvedAttemptId) {
        throw new Error("Rollback receipt requested Attempt does not match current authority");
      }
      const comparisonEpochStart = (this.db.prepare(`SELECT COALESCE(MAX(rowid),0) AS value
        FROM attempt_shadow_comparisons WHERE gate_sample=1`).get() as { value: number }).value;
      this.db.prepare(`UPDATE attempt_authority_state SET mode='shadow',status='blocked',
        approved_attempt_id=NULL,receipt_id=?,sample_count=0,mismatch_count=0,scenario_coverage_json='[]',
        comparison_epoch_start=?,comparison_watermark=?,last_mismatch_id=NULL,updated_at=? WHERE id=1`).run(
        input.receiptId, comparisonEpochStart, comparisonEpochStart, input.timestamp ?? Date.now(),
      );
      return this.getAuthorityState();
    })();
  }

  private getReceipt(id: string): AttemptAuthorityReceipt | undefined {
    return this.db.prepare(`SELECT id,requested_attempt_id as requestedAttemptId,decision,actor,reason,
      created_at as createdAt FROM attempt_authority_receipts WHERE id=?`).get(id) as AttemptAuthorityReceipt | undefined;
  }
}
