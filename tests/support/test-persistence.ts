import { randomUUID } from "node:crypto";
import type { CoreApplicationPersistencePort } from "@tagent/core-service/application";
import { httpArtifactContent } from "@tagent/core-service/composition";
import type { RunId } from "@tagent/execution/domain";
import type { RuntimeTransitionCommand } from "@tagent/execution/ports";
import type { AppDependencies, HttpPersistencePort } from "@tagent/http-fastify";
import { SqlitePersistence, type Store } from "@tagent/persistence-sqlite";
import type { SynchronousResult } from "@tagent/persistence-sqlite/unit-of-work";

function testPersistence(store: Store): SqlitePersistence {
  return new SqlitePersistence(store, {
    run<T>(work: () => T & SynchronousResult<T>): T {
      return store.db.transaction(work)();
    },
  });
}

/** Drives test fixtures through the same fenced transition authority as production. */
export function transitionTaskRun(
  store: Store,
  runId: RunId,
  kind: RuntimeTransitionCommand["kind"],
  reason = "",
  data: RuntimeTransitionCommand["data"] = {},
) {
  const persistence = testPersistence(store);
  const attempt = persistence.attempts.getActiveAttempt(runId);
  if (!attempt) throw new Error(`Active Attempt for test Run ${runId} was not found`);
  const ownerId = `test-transition:${randomUUID()}`;
  const lease = persistence.attempts.acquireExecutionLease({
    attemptId: attempt.id,
    expectedVersion: attempt.version,
    ownerId,
    leaseMs: 60_000,
  });
  try {
    const result = persistence.taskRunTransitions.transitionRuntime({ kind, reason, data }, {
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      leaseToken: lease.token,
      executionFence: lease.fence,
    });
    return { result, run: persistence.taskRuns.getRun(runId)! };
  } finally {
    persistence.attempts.releaseExecutionLease({
      attemptId: attempt.id,
      ownerId,
      leaseToken: lease.token,
      fence: lease.fence,
    });
  }
}

/** Cancels a fixture through the production Attempt authority. */
export function cancelTaskRun(store: Store, runId: RunId, reason = "Cancelled by test") {
  const persistence = testPersistence(store);
  const attempt = persistence.attempts.getActiveAttempt(runId);
  if (!attempt) throw new Error(`Active Attempt for test Run ${runId} was not found`);
  return persistence.attempts.cancelAttempt({ attemptId: attempt.id, reason });
}

export function corePersistence(store: Store): CoreApplicationPersistencePort {
  return testPersistence(store);
}

export function httpPersistence(store: Store): HttpPersistencePort {
  const persistence = testPersistence(store);
  return {
    profileContracts: persistence.profileContracts,
    operatorRead: persistence.operatorRead,
    sessions: persistence.sessions,
    submissions: persistence.submissions,
    taskRuns: persistence.taskRuns,
    taskRunCommands: persistence.taskRunCommands,
    supervisorDecisions: persistence.supervisorDecisions,
    contextManifests: persistence.contextManifests,
    controlInbox: persistence.controlInbox,
    operations: persistence.operations,
    transcript: persistence.transcript,
    evidence: persistence.evidence,
    eventConsumers: persistence.eventConsumers,
    workspaceGoals: persistence.workspaceGoals,
    workspaceGoalOperations: persistence.workspaceGoalOperations,
  };
}

export function httpTestResources(store: Store): Pick<AppDependencies, "persistence" | "artifacts" | "closeResources"> {
  return {
    persistence: httpPersistence(store),
    artifacts: httpArtifactContent,
    closeResources: async () => { store.close(); },
  };
}
