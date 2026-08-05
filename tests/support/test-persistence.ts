import type { AgentServicePersistencePort } from "@tagent/core-service/application";
import { httpArtifactContent } from "@tagent/core-service/composition";
import type { AppDependencies, HttpPersistencePort } from "@tagent/http-fastify";
import type { LearningServicePersistencePort, WorkflowServicePersistencePort } from "@tagent/learning/ports";
import { LegacyStoreAdapter, type Store } from "@tagent/persistence-sqlite";
import type { SynchronousResult } from "@tagent/persistence-sqlite/unit-of-work";

function testPersistence(store: Store): LegacyStoreAdapter {
  return new LegacyStoreAdapter(store, {
    run<T>(work: () => T & SynchronousResult<T>): T {
      return store.db.transaction(work)();
    },
  });
}

export function agentPersistence(store: Store): AgentServicePersistencePort {
  return testPersistence(store);
}

export function workflowPersistence(store: Store): WorkflowServicePersistencePort {
  return testPersistence(store).workflow;
}

export function learningPersistence(store: Store): LearningServicePersistencePort {
  return testPersistence(store).learning;
}

export function httpPersistence(store: Store): HttpPersistencePort {
  const persistence = testPersistence(store);
  return {
    sessions: persistence.sessions,
    submissions: persistence.submissions,
    taskRuns: persistence.taskRuns,
    supervisorDecisions: persistence.supervisorDecisions,
    contextManifests: persistence.contextManifests,
    controlInbox: persistence.controlInbox,
    operations: persistence.operations,
    transcript: persistence.transcript,
    evidence: persistence.evidence,
    eventConsumers: persistence.eventConsumers,
  };
}

export function httpTestResources(store: Store): Pick<AppDependencies, "persistence" | "artifacts" | "closeResources"> {
  return {
    persistence: httpPersistence(store),
    artifacts: httpArtifactContent,
    closeResources: async () => { store.close(); },
  };
}
