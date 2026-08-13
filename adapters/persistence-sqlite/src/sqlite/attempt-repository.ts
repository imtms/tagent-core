import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { assertAttemptTransition } from "@tagent/execution/domain";
import type {
  Attempt,
  AttemptShadowComparison,
  AttemptTransitionAudit,
  CandidateResult,
  ExecutionLease,
} from "@tagent/execution/domain";
import type { AttemptRepository } from "@tagent/execution/ports";
import {
  appendProjectionPair,
  finalizeProjectionCheckpoint,
} from "./canonical-integration-event.js";

type AttemptRow = Omit<Attempt, "active"> & { active: number };

function asAttempt(row: AttemptRow | undefined): Attempt | undefined {
  return row ? { ...row, active: Boolean(row.active) } : undefined;
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return {};
  return parsed as Record<string, unknown>;
}

export class SqliteAttemptRepository implements AttemptRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly readTaskRunSnapshot: (runId: string) => unknown = () => null,
  ) {}

  getAttempt(attemptId: string): Attempt | undefined {
    return asAttempt(this.db.prepare(`SELECT id,run_id as runId,ordinal,trigger,status,active,version,
      legacy_event_seq as legacyEventSeq,started_at as startedAt,updated_at as updatedAt,
      completed_at as completedAt,reconstruction_state as reconstructionState
      FROM attempts WHERE id=?`).get(attemptId) as AttemptRow | undefined);
  }

  getAttemptForRun(runId: string, ordinal: number): Attempt | undefined {
    return asAttempt(this.db.prepare(`SELECT id,run_id as runId,ordinal,trigger,status,active,version,
      legacy_event_seq as legacyEventSeq,started_at as startedAt,updated_at as updatedAt,
      completed_at as completedAt,reconstruction_state as reconstructionState
      FROM attempts WHERE run_id=? AND ordinal=?`).get(runId, ordinal) as AttemptRow | undefined);
  }

  getActiveAttempt(runId: string): Attempt | undefined {
    return asAttempt(this.db.prepare(`SELECT id,run_id as runId,ordinal,trigger,status,active,version,
      legacy_event_seq as legacyEventSeq,started_at as startedAt,updated_at as updatedAt,
      completed_at as completedAt,reconstruction_state as reconstructionState
      FROM attempts WHERE run_id=? AND active=1`).get(runId) as AttemptRow | undefined);
  }

  listAttempts(runId: string): Attempt[] {
    return (this.db.prepare(`SELECT id,run_id as runId,ordinal,trigger,status,active,version,
      legacy_event_seq as legacyEventSeq,started_at as startedAt,updated_at as updatedAt,
      completed_at as completedAt,reconstruction_state as reconstructionState
      FROM attempts WHERE run_id=? ORDER BY ordinal`).all(runId) as AttemptRow[])
      .map((row) => asAttempt(row)!);
  }

  listTransitionAudit(attemptId: string): AttemptTransitionAudit[] {
    return this.db.prepare(`SELECT id,attempt_id as attemptId,run_id as runId,ordinal,
      from_status as fromStatus,to_status as toStatus,trigger,scenario,reason,version,
      legacy_event_seq as legacyEventSeq,created_at as createdAt
      FROM attempt_transition_audit WHERE attempt_id=? ORDER BY created_at,rowid`).all(attemptId) as AttemptTransitionAudit[];
  }

  listShadowComparisons(filter: { attemptId?: string; runId?: string } = {}): AttemptShadowComparison[] {
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (filter.attemptId) {
      clauses.push("comparison.attempt_id=?");
      parameters.push(filter.attemptId);
    }
    if (filter.runId) {
      clauses.push("attempt.run_id=?");
      parameters.push(filter.runId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT comparison.id,comparison.attempt_id as attemptId,
      comparison.scenario,comparison.legacy_json as legacyJson,
      comparison.projected_json as projectedJson,comparison.mismatch,
      comparison.created_at as createdAt FROM attempt_shadow_comparisons comparison
      JOIN attempts attempt ON attempt.id=comparison.attempt_id ${where}
      ORDER BY comparison.rowid`).all(...parameters) as Array<{
        id: string;
        attemptId: AttemptShadowComparison["attemptId"];
        scenario: string;
        legacyJson: string;
        projectedJson: string;
        mismatch: number;
        createdAt: number;
      }>;
    return rows.map(({ legacyJson, projectedJson, mismatch, ...row }) => ({
      ...row,
      legacy: parseObject(legacyJson),
      projected: parseObject(projectedJson),
      mismatch: Boolean(mismatch),
    }));
  }

  acquireExecutionLease(input: {
    attemptId: string;
    expectedVersion: number;
    ownerId: string;
    leaseMs: number;
    timestamp?: number;
  }): ExecutionLease {
    return this.db.transaction(() => {
      const timestamp = input.timestamp ?? Date.now();
      if (!input.ownerId.trim()) throw new TypeError("Execution lease ownerId is required");
      if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) throw new TypeError("Execution leaseMs must be positive");
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt) throw new Error(`Attempt ${input.attemptId} does not exist`);
      if (attempt.version !== input.expectedVersion) throw new Error(`Attempt version mismatch for ${input.attemptId}`);
      if (!attempt.active || attempt.status !== "running") throw new Error(`Attempt ${input.attemptId} is not active`);
      const previous = this.db.prepare(`SELECT fence,lease_until as leaseUntil,released_at as releasedAt
        FROM execution_leases WHERE attempt_id=?`).get(input.attemptId) as {
          fence: number;
          leaseUntil: number;
          releasedAt: number | null;
        } | undefined;
      if (previous && previous.releasedAt === null && previous.leaseUntil > timestamp) {
        throw new Error(`Attempt ${input.attemptId} already has an execution lease`);
      }
      const lease: ExecutionLease = {
        attemptId: attempt.id,
        ownerId: input.ownerId,
        token: randomUUID(),
        fence: (previous?.fence ?? 0) + 1,
        attemptVersion: attempt.version,
        leaseUntil: timestamp + input.leaseMs,
        heartbeatAt: timestamp,
        releasedAt: null,
      };
      this.db.prepare(`INSERT INTO execution_leases
        (attempt_id,owner_id,lease_token,fence,attempt_version,lease_until,heartbeat_at,released_at)
        VALUES (?,?,?,?,?,?,?,NULL)
        ON CONFLICT(attempt_id) DO UPDATE SET owner_id=excluded.owner_id,
          lease_token=excluded.lease_token,fence=excluded.fence,
          attempt_version=excluded.attempt_version,lease_until=excluded.lease_until,
          heartbeat_at=excluded.heartbeat_at,released_at=NULL`).run(
        lease.attemptId, lease.ownerId, lease.token, lease.fence, lease.attemptVersion,
        lease.leaseUntil, lease.heartbeatAt,
      );
      return lease;
    })();
  }

  renewExecutionLease(input: {
    attemptId: string;
    ownerId: string;
    leaseToken: string;
    fence: number;
    leaseMs: number;
    timestamp?: number;
  }): ExecutionLease {
    return this.db.transaction(() => {
      const timestamp = input.timestamp ?? Date.now();
      if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) throw new TypeError("Execution leaseMs must be positive");
      const lease = this.requireLease(input.attemptId, input.leaseToken, input.fence, timestamp, input.ownerId);
      const attempt = this.getAttempt(input.attemptId);
      const running = attempt?.status === "running" && attempt.version === lease.attemptVersion;
      const proposedCandidate = attempt?.status === "settling" && attempt.version === lease.attemptVersion + 1
        ? this.getCandidateForAttempt(input.attemptId)
        : undefined;
      const settling = Boolean(proposedCandidate
        && proposedCandidate.status === "proposed"
        && proposedCandidate.attemptVersion === attempt?.version);
      if (!attempt || !attempt.active || !running && !settling) {
        throw new Error(`Attempt version changed for ${input.attemptId}`);
      }
      const leaseUntil = timestamp + input.leaseMs;
      const updated = this.db.prepare(`UPDATE execution_leases SET lease_until=?,heartbeat_at=?
        WHERE attempt_id=? AND owner_id=? AND lease_token=? AND fence=? AND released_at IS NULL`)
        .run(leaseUntil, timestamp, input.attemptId, input.ownerId, input.leaseToken, input.fence);
      if (updated.changes !== 1) throw new Error(`Execution lease changed for Attempt ${input.attemptId}`);
      return { ...lease, leaseUntil, heartbeatAt: timestamp };
    })();
  }

  releaseExecutionLease(input: {
    attemptId: string;
    ownerId: string;
    leaseToken: string;
    fence: number;
    timestamp?: number;
  }): boolean {
    const timestamp = input.timestamp ?? Date.now();
    return this.db.prepare(`UPDATE execution_leases SET released_at=?
      WHERE attempt_id=? AND owner_id=? AND lease_token=? AND fence=? AND released_at IS NULL`)
      .run(timestamp, input.attemptId, input.ownerId, input.leaseToken, input.fence).changes === 1;
  }

  recordCandidateResult(input: {
    id: string;
    attemptId: string;
    expectedVersion: number;
    leaseToken: string;
    fence: number;
    response: string;
    timestamp?: number;
  }): CandidateResult {
    return this.db.transaction(() => {
      const timestamp = input.timestamp ?? Date.now();
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt) throw new Error(`Attempt ${input.attemptId} does not exist`);
      const responseHash = createHash("sha256").update(input.response).digest("hex");
      const existing = this.getCandidateForAttempt(input.attemptId);
      if (existing) {
        const executionLease = this.requireLease(input.attemptId, input.leaseToken, input.fence, timestamp);
        if (executionLease.attemptVersion !== input.expectedVersion
          || attempt.version !== existing.attemptVersion
          || existing.attemptVersion !== input.expectedVersion + 1) {
          throw new Error(`Attempt version mismatch for ${input.attemptId}`);
        }
        if (existing.responseHash !== responseHash || existing.response !== input.response) {
          throw new Error(`Attempt ${input.attemptId} already has a different Candidate result`);
        }
        return existing;
      }
      if (attempt.version !== input.expectedVersion) throw new Error(`Attempt version mismatch for ${input.attemptId}`);
      const executionLease = this.requireLease(input.attemptId, input.leaseToken, input.fence, timestamp);
      if (executionLease.attemptVersion !== attempt.version) {
        throw new Error(`Execution lease Attempt version mismatch for ${input.attemptId}`);
      }
      assertAttemptTransition(attempt.status, "settling");
      const settlingVersion = attempt.version + 1;
      const transitioned = this.db.prepare(`UPDATE attempts SET status='settling',version=version+1,
        updated_at=? WHERE id=? AND version=? AND active=1 AND status='running'`)
        .run(timestamp, attempt.id, attempt.version);
      if (transitioned.changes !== 1) throw new Error(`Attempt version changed before candidate settlement`);
      this.db.prepare(`INSERT OR IGNORE INTO candidate_results
        (id,attempt_id,attempt_version,response,response_hash,status,created_at)
        VALUES (?,?,?,?,?,'proposed',?)`).run(
        input.id, input.attemptId, settlingVersion, input.response, responseHash, timestamp,
      );
      const candidate = this.getCandidate(input.id);
      if (!candidate || candidate.attemptId !== attempt.id || candidate.attemptVersion !== settlingVersion
        || candidate.responseHash !== responseHash || candidate.response !== input.response) {
        throw new Error(`Candidate result ${input.id} already exists with different content`);
      }
      this.db.prepare(`INSERT INTO attempt_transition_audit
        (id,attempt_id,run_id,ordinal,from_status,to_status,trigger,scenario,reason,version,legacy_event_seq,created_at)
        VALUES (?,?,?,?,?,'settling',?,'terminal','candidate_result',?,?,?)`).run(
        randomUUID(), attempt.id, attempt.runId, attempt.ordinal, attempt.status, attempt.trigger,
        settlingVersion, attempt.legacyEventSeq, timestamp,
      );
      return candidate;
    })();
  }

  settleAttempt(input: Parameters<AttemptRepository["settleAttempt"]>[0]): Attempt {
    return this.db.transaction(() => {
      const timestamp = input.timestamp ?? Date.now();
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt) throw new Error(`Attempt ${input.attemptId} does not exist`);
      if (attempt.version !== input.expectedVersion) throw new Error(`Attempt version mismatch for ${input.attemptId}`);
      if (!attempt.active || attempt.status !== "settling") throw new Error(`Attempt ${input.attemptId} is not settling`);
      assertAttemptTransition(attempt.status, input.status);
      const authority = this.db.prepare(`SELECT mode,status,approved_attempt_id as approvedAttemptId
        FROM attempt_authority_state WHERE id=1`).get() as {
          mode: string;
          status: string;
          approvedAttemptId: string | null;
        } | undefined;
      if (!authority || authority.mode !== "canary" || authority.status !== "approved"
        || authority.approvedAttemptId !== attempt.id) {
        throw new Error(`Attempt ${input.attemptId} is not approved for canary settlement`);
      }
      const executionLease = this.requireLease(input.attemptId, input.leaseToken, input.fence, timestamp);
      if (executionLease.attemptVersion !== attempt.version - 1) {
        throw new Error(`Execution lease Attempt version mismatch for ${input.attemptId}`);
      }
      const candidate = this.getCandidate(input.candidateResultId);
      if (!candidate || candidate.attemptId !== attempt.id) throw new Error(`Candidate result ${input.candidateResultId} does not belong to Attempt`);
      if (candidate.attemptVersion !== attempt.version) throw new Error("Candidate result Attempt version mismatch");
      if (candidate.status !== "proposed") throw new Error(`Candidate result ${candidate.id} is already settled`);
      const run = this.db.prepare(`SELECT status,attempt,last_event_seq as lastEventSeq
        ,session_id as sessionId FROM runs WHERE id=?`).get(attempt.runId) as {
          status: string;
          attempt: number;
          lastEventSeq: number;
          sessionId: string;
        } | undefined;
      if (!run || run.attempt !== attempt.ordinal || run.status !== "running") {
        throw new Error(`TaskRun projection is stale for Attempt ${attempt.id}`);
      }
      const decision = this.db.prepare(`SELECT run_id as runId,attempt,status,action
        FROM supervisor_decisions WHERE id=?`).get(input.supervisorDecisionId) as {
          runId: string;
          attempt: number;
          status: string;
          action: string;
        } | undefined;
      if (!decision || decision.runId !== attempt.runId || decision.attempt !== attempt.ordinal
        || decision.status !== "proposed") {
        throw new Error(`Supervisor decision ${input.supervisorDecisionId} is not proposed for Attempt`);
      }
      if (input.status === "completed" && decision.action !== "complete_taskrun") {
        throw new Error(`Supervisor decision ${input.supervisorDecisionId} does not authorize completion`);
      }

      let eventSeq = run.lastEventSeq + 1;
      const eventType = `run.${input.status}`;
      const phase = input.status === "completed" ? "done" : input.status === "blocked" ? "blocked" : undefined;
      const completedAt = ["completed", "failed", "cancelled"].includes(input.status) ? timestamp : null;
      if (input.status === "blocked") {
        this.db.prepare(`INSERT INTO run_events (run_id,seq,attempt_id,type,data,created_at)
          VALUES (?,?,?,'message.rejected',?,?)`).run(
          attempt.runId, eventSeq, attempt.id,
          JSON.stringify({
            response: candidate.response,
            reason: input.reason,
            supervisionDecisionId: input.supervisorDecisionId,
            action: decision.action,
          }),
          timestamp,
        );
        eventSeq += 1;
      }
      const projectionPayload = {
        attemptId: attempt.id,
        candidateResultId: candidate.id,
        response: candidate.response,
        supervisionDecisionId: input.supervisorDecisionId,
        action: decision.action,
        reason: input.reason,
      };
      this.db.prepare(`INSERT INTO run_events (run_id,seq,attempt_id,type,data,created_at)
        VALUES (?,?,?,?,?,?)`).run(
        attempt.runId,
        eventSeq,
        attempt.id,
        eventType,
        JSON.stringify(projectionPayload),
        timestamp,
      );
      const attemptUpdate = this.db.prepare(`UPDATE attempts SET status=?,active=0,version=version+1,
        legacy_event_seq=?,updated_at=?,completed_at=?,reconstruction_state='complete'
        WHERE id=? AND version=? AND active=1 AND status='settling'`).run(
        input.status, eventSeq, timestamp, timestamp, attempt.id, attempt.version,
      );
      if (attemptUpdate.changes !== 1) throw new Error(`Attempt version changed during settlement`);
      const runUpdate = this.db.prepare(`UPDATE runs SET status=?,phase=COALESCE(?,phase),blocked_reason=?,
        last_event_seq=?,completed_at=?,updated_at=? WHERE id=? AND status='running' AND attempt=?`)
        .run(input.status, phase, input.reason, eventSeq, completedAt, timestamp, attempt.runId, attempt.ordinal);
      if (runUpdate.changes !== 1) throw new Error(`TaskRun changed during Attempt settlement`);
      const candidateStatus = input.status === "completed" ? "accepted" : "rejected";
      this.db.prepare(`UPDATE candidate_results SET status=?,settled_at=?
        WHERE id=? AND status='proposed'`).run(candidateStatus, timestamp, candidate.id);
      this.db.prepare(`UPDATE execution_leases SET released_at=? WHERE attempt_id=? AND lease_token=? AND fence=?`)
        .run(timestamp, attempt.id, input.leaseToken, input.fence);
      this.db.prepare(`UPDATE supervisor_decisions SET status='executed',error='',executed_at=?
        WHERE id=? AND status='proposed'`).run(timestamp, input.supervisorDecisionId);
      if (input.status === "completed" && candidate.response.trim()) {
        this.db.prepare(`INSERT INTO messages (session_id,role,content,created_at)
          VALUES (?,'assistant',?,?)`).run(run.sessionId, candidate.response, timestamp);
        this.db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(timestamp, run.sessionId);
      }
      finalizeProjectionCheckpoint(this.db, {
        runId: attempt.runId,
        attemptId: attempt.id,
        attemptOrdinal: attempt.ordinal,
        eventSeq,
        timestamp,
      });
      this.db.prepare(`INSERT INTO attempt_transition_audit
        (id,attempt_id,run_id,ordinal,from_status,to_status,trigger,scenario,reason,version,legacy_event_seq,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(), attempt.id, attempt.runId, attempt.ordinal, attempt.status, input.status,
        attempt.trigger, "terminal", input.reason, attempt.version + 1, eventSeq, timestamp,
      );
      const comparisonSnapshot = JSON.stringify({
        runId: attempt.runId,
        ordinal: attempt.ordinal,
        status: input.status,
        legacyEventSeq: eventSeq,
        active: false,
      });
      this.db.prepare(`INSERT INTO attempt_shadow_comparisons
        (id,attempt_id,scenario,legacy_json,projected_json,mismatch,gate_sample,created_at)
        VALUES (?,?, 'terminal',?,?,0,0,?)`).run(
        randomUUID(), attempt.id, comparisonSnapshot, comparisonSnapshot, timestamp,
      );
      appendProjectionPair(this.db, {
        runId: attempt.runId,
        attemptId: attempt.id,
        attemptOrdinal: attempt.ordinal,
        lifecycle: eventType,
        outcome: input.status,
        eventSeq,
        runEventType: eventType,
        payload: projectionPayload,
        taskRunSnapshot: this.requireTaskRunSnapshot(attempt.runId),
        timestamp,
      });
      return this.getAttempt(attempt.id)!;
    })();
  }

  recoverInterruptedAttempt(
    input: Parameters<AttemptRepository["recoverInterruptedAttempt"]>[0],
  ): ReturnType<AttemptRepository["recoverInterruptedAttempt"]> {
    return this.db.transaction(() => {
      const timestamp = input.timestamp ?? Date.now();
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt) throw new Error(`Attempt ${input.attemptId} does not exist`);
      const lease = this.getLease(input.attemptId);
      if (!lease) throw new Error(`Execution lease for Attempt ${input.attemptId} does not exist`);
      if (lease.ownerId !== input.ownerId) throw new Error(`Execution lease owner mismatch for Attempt ${input.attemptId}`);
      if (lease.token !== input.leaseToken) throw new Error(`Execution lease token mismatch for Attempt ${input.attemptId}`);
      if (lease.fence !== input.fence) throw new Error(`Execution lease fence mismatch for Attempt ${input.attemptId}`);

      const run = this.db.prepare(`SELECT status,attempt,last_event_seq as lastEventSeq
        FROM runs WHERE id=?`).get(attempt.runId) as {
          status: string;
          attempt: number;
          lastEventSeq: number;
        } | undefined;
      if (attempt.status === "interrupted" && !attempt.active) {
        if (!run || run.attempt !== attempt.ordinal || run.status !== "interrupted" || lease.releasedAt === null) {
          throw new Error(`Interrupted Attempt ${attempt.id} recovery state is inconsistent`);
        }
        const pendingCandidate = this.db.prepare(`SELECT 1 FROM candidate_results
          WHERE attempt_id=? AND status='proposed'`).get(attempt.id);
        const pendingDecision = this.db.prepare(`SELECT 1 FROM supervisor_decisions
          WHERE run_id=? AND attempt=? AND status='proposed'`).get(attempt.runId, attempt.ordinal);
        if (pendingCandidate || pendingDecision) throw new Error(`Interrupted Attempt ${attempt.id} recovery is incomplete`);
        return { attempt, recovered: false };
      }
      if (lease.releasedAt !== null) throw new Error(`Execution lease for Attempt ${input.attemptId} was released`);
      const running = attempt.status === "running" && attempt.version === input.expectedVersion;
      const candidate = this.getCandidateForAttempt(attempt.id);
      const settling = attempt.status === "settling"
        && attempt.version === input.expectedVersion + 1
        && candidate?.status === "proposed"
        && candidate.attemptVersion === attempt.version;
      if (!attempt.active || !running && !settling) {
        throw new Error(`Attempt version changed for ${input.attemptId}`);
      }
      if (lease.attemptVersion !== input.expectedVersion) {
        throw new Error(`Execution lease Attempt version mismatch for ${input.attemptId}`);
      }
      if (!run || run.attempt !== attempt.ordinal || run.status !== "running") {
        throw new Error(`TaskRun projection is stale for Attempt ${attempt.id}`);
      }
      if (input.supervisorDecisionId) {
        const decision = this.db.prepare(`SELECT run_id as runId,attempt,status FROM supervisor_decisions
          WHERE id=?`).get(input.supervisorDecisionId) as {
            runId: string;
            attempt: number;
            status: string;
          } | undefined;
        if (!decision || decision.runId !== attempt.runId || decision.attempt !== attempt.ordinal
          || decision.status !== "proposed") {
          throw new Error(`Supervisor decision ${input.supervisorDecisionId} is not proposed for Attempt`);
        }
      }

      assertAttemptTransition(attempt.status, "interrupted");
      const eventSeq = run.lastEventSeq + 1;
      const nextVersion = attempt.version + 1;
      const data = {
        attemptId: attempt.id,
        reason: input.reason,
        recoverable: true,
        ...(input.supervisorDecisionId ? { supervisorDecisionId: input.supervisorDecisionId } : {}),
      };
      this.appendEvent(attempt.runId, "run.interrupted", data, attempt.id, eventSeq, timestamp);
      const attemptUpdate = this.db.prepare(`UPDATE attempts SET status='interrupted',active=0,
        version=version+1,legacy_event_seq=?,updated_at=?,completed_at=NULL,reconstruction_state='complete'
        WHERE id=? AND version=? AND active=1 AND status=?`).run(
        eventSeq, timestamp, attempt.id, attempt.version, attempt.status,
      );
      if (attemptUpdate.changes !== 1) throw new Error(`Attempt version changed during recovery`);
      const runUpdate = this.db.prepare(`UPDATE runs SET status='interrupted',blocked_reason=?,
        last_event_seq=?,completed_at=NULL,updated_at=? WHERE id=? AND status='running' AND attempt=?`)
        .run(input.reason, eventSeq, timestamp, attempt.runId, attempt.ordinal);
      if (runUpdate.changes !== 1) throw new Error(`TaskRun changed during Attempt recovery`);
      this.db.prepare(`UPDATE candidate_results SET status='rejected',settled_at=?
        WHERE attempt_id=? AND status='proposed'`).run(timestamp, attempt.id);
      this.db.prepare(`UPDATE supervisor_decisions SET status='superseded',error=?,executed_at=?
        WHERE run_id=? AND attempt=? AND status='proposed'`).run(
        input.reason, timestamp, attempt.runId, attempt.ordinal,
      );
      const released = this.db.prepare(`UPDATE execution_leases SET released_at=?
        WHERE attempt_id=? AND lease_token=? AND fence=? AND released_at IS NULL`).run(
        timestamp, attempt.id, input.leaseToken, input.fence,
      );
      if (released.changes !== 1) throw new Error(`Execution lease changed during Attempt recovery`);
      finalizeProjectionCheckpoint(this.db, {
        runId: attempt.runId,
        attemptId: attempt.id,
        attemptOrdinal: attempt.ordinal,
        eventSeq,
        timestamp,
      });
      this.recordTerminalArtifacts(attempt, "interrupted", input.reason, eventSeq, nextVersion, data, timestamp);
      const recoveredAttempt = this.getAttempt(attempt.id)!;
      return {
        attempt: recoveredAttempt,
        event: { runId: attempt.runId, seq: eventSeq, type: "run.interrupted" as const, data, createdAt: timestamp },
        recovered: true,
      };
    })();
  }

  cancelAttempt(
    input: Parameters<AttemptRepository["cancelAttempt"]>[0],
  ): ReturnType<AttemptRepository["cancelAttempt"]> {
    return this.db.transaction(() => {
      const timestamp = input.timestamp ?? Date.now();
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt) throw new Error(`Attempt ${input.attemptId} does not exist`);
      const run = this.db.prepare(`SELECT status,attempt,last_event_seq as lastEventSeq
        FROM runs WHERE id=?`).get(attempt.runId) as {
          status: string;
          attempt: number;
          lastEventSeq: number;
        } | undefined;
      if (attempt.status === "cancelled" && !attempt.active) {
        if (!run || run.attempt !== attempt.ordinal || run.status !== "cancelled") {
          throw new Error(`Cancelled Attempt ${attempt.id} state is inconsistent`);
        }
        return { attempt, cancelled: false };
      }
      if (!attempt.active || !["running", "settling"].includes(attempt.status)) {
        throw new Error(`Attempt ${input.attemptId} is not cancellable`);
      }
      if (!run || run.attempt !== attempt.ordinal || run.status !== "running") {
        throw new Error(`TaskRun projection is stale for Attempt ${attempt.id}`);
      }
      assertAttemptTransition(attempt.status, "cancelled");
      const eventSeq = run.lastEventSeq + 1;
      const nextVersion = attempt.version + 1;
      const data = { attemptId: attempt.id, reason: input.reason };
      this.appendEvent(attempt.runId, "run.cancelled", data, attempt.id, eventSeq, timestamp);
      const attemptUpdate = this.db.prepare(`UPDATE attempts SET status='cancelled',active=0,
        version=version+1,legacy_event_seq=?,updated_at=?,completed_at=?,reconstruction_state='complete'
        WHERE id=? AND version=? AND active=1 AND status=?`).run(
        eventSeq, timestamp, timestamp, attempt.id, attempt.version, attempt.status,
      );
      if (attemptUpdate.changes !== 1) throw new Error(`Attempt version changed during cancellation`);
      const runUpdate = this.db.prepare(`UPDATE runs SET status='cancelled',blocked_reason=?,
        last_event_seq=?,completed_at=?,updated_at=? WHERE id=? AND status='running' AND attempt=?`)
        .run(input.reason, eventSeq, timestamp, timestamp, attempt.runId, attempt.ordinal);
      if (runUpdate.changes !== 1) throw new Error(`TaskRun changed during Attempt cancellation`);
      this.db.prepare(`UPDATE candidate_results SET status='rejected',settled_at=?
        WHERE attempt_id=? AND status='proposed'`).run(timestamp, attempt.id);
      this.db.prepare(`UPDATE supervisor_decisions SET status='superseded',error=?,executed_at=?
        WHERE run_id=? AND attempt=? AND status='proposed'`).run(
        input.reason, timestamp, attempt.runId, attempt.ordinal,
      );
      this.db.prepare(`UPDATE execution_leases SET released_at=?
        WHERE attempt_id=? AND released_at IS NULL`).run(timestamp, attempt.id);
      finalizeProjectionCheckpoint(this.db, {
        runId: attempt.runId,
        attemptId: attempt.id,
        attemptOrdinal: attempt.ordinal,
        eventSeq,
        timestamp,
      });
      this.recordTerminalArtifacts(attempt, "cancelled", input.reason, eventSeq, nextVersion, data, timestamp);
      const cancelledAttempt = this.getAttempt(attempt.id)!;
      return {
        attempt: cancelledAttempt,
        event: { runId: attempt.runId, seq: eventSeq, type: "run.cancelled" as const, data, createdAt: timestamp },
        cancelled: true,
      };
    })();
  }

  private recordTerminalArtifacts(
    attempt: Attempt,
    status: "interrupted" | "cancelled",
    reason: string,
    eventSeq: number,
    version: number,
    payload: Record<string, unknown>,
    timestamp: number,
  ): void {
    this.db.prepare(`INSERT INTO attempt_transition_audit
      (id,attempt_id,run_id,ordinal,from_status,to_status,trigger,scenario,reason,version,legacy_event_seq,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), attempt.id, attempt.runId, attempt.ordinal, attempt.status, status,
      attempt.trigger, status === "interrupted" ? "recovery" : "terminal", reason, version, eventSeq, timestamp,
    );
    const comparisonSnapshot = JSON.stringify({
      runId: attempt.runId,
      ordinal: attempt.ordinal,
      status,
      legacyEventSeq: eventSeq,
      active: false,
    });
    this.db.prepare(`INSERT INTO attempt_shadow_comparisons
      (id,attempt_id,scenario,legacy_json,projected_json,mismatch,gate_sample,created_at)
      VALUES (?,?,?, ?,?,0,0,?)`).run(
      randomUUID(), attempt.id, status === "interrupted" ? "recovery" : "terminal",
      comparisonSnapshot, comparisonSnapshot, timestamp,
    );
    appendProjectionPair(this.db, {
      runId: attempt.runId,
      attemptId: attempt.id,
      attemptOrdinal: attempt.ordinal,
      lifecycle: `run.${status}`,
      outcome: status,
      eventSeq,
      runEventType: `run.${status}`,
      payload,
      taskRunSnapshot: this.requireTaskRunSnapshot(attempt.runId),
      timestamp,
    });
  }

  private appendEvent(
    runId: string,
    type: string,
    data: Record<string, unknown>,
    attemptId: string,
    seq: number,
    timestamp: number,
  ): void {
    this.db.prepare(`INSERT INTO run_events (run_id,seq,attempt_id,type,data,created_at)
      VALUES (?,?,?,?,?,?)`).run(runId, seq, attemptId, type, JSON.stringify(data), timestamp);
  }

  private requireTaskRunSnapshot(runId: string): Record<string, unknown> {
    const snapshot = this.readTaskRunSnapshot(runId);
    if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object") {
      throw new Error(`TaskRun snapshot ${runId} does not exist`);
    }
    return snapshot as Record<string, unknown>;
  }

  private getCandidate(id: string): CandidateResult | undefined {
    return this.db.prepare(`SELECT id,attempt_id as attemptId,attempt_version as attemptVersion,
      response,response_hash as responseHash,status,created_at as createdAt,settled_at as settledAt
      FROM candidate_results WHERE id=?`).get(id) as CandidateResult | undefined;
  }

  private getCandidateForAttempt(attemptId: string): CandidateResult | undefined {
    return this.db.prepare(`SELECT id,attempt_id as attemptId,attempt_version as attemptVersion,
      response,response_hash as responseHash,status,created_at as createdAt,settled_at as settledAt
      FROM candidate_results WHERE attempt_id=?`).get(attemptId) as CandidateResult | undefined;
  }

  private requireLease(
    attemptId: string,
    leaseToken: string,
    fence: number,
    timestamp: number,
    ownerId?: string,
  ): ExecutionLease {
    const lease = this.getLease(attemptId);
    if (!lease) throw new Error(`Execution lease for Attempt ${attemptId} does not exist`);
    if (lease.token !== leaseToken) throw new Error(`Execution lease token mismatch for Attempt ${attemptId}`);
    if (lease.fence !== fence) throw new Error(`Execution lease fence mismatch for Attempt ${attemptId}`);
    if (ownerId !== undefined && lease.ownerId !== ownerId) throw new Error(`Execution lease owner mismatch for Attempt ${attemptId}`);
    if (lease.releasedAt !== null) throw new Error(`Execution lease for Attempt ${attemptId} was released`);
    if (lease.leaseUntil <= timestamp) throw new Error(`Execution lease for Attempt ${attemptId} expired`);
    return lease;
  }

  private getLease(attemptId: string): ExecutionLease | undefined {
    return this.db.prepare(`SELECT attempt_id as attemptId,owner_id as ownerId,
      lease_token as token,fence,attempt_version as attemptVersion,lease_until as leaseUntil,
      heartbeat_at as heartbeatAt,released_at as releasedAt FROM execution_leases WHERE attempt_id=?`)
      .get(attemptId) as ExecutionLease | undefined;
  }
}
