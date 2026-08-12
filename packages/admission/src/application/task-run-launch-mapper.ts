import type { TaskRunContract } from "../domain/task-run-contract.js";
import type { TaskRunContractSnapshot, TaskRunLaunchSpec } from "@tagent/execution/domain";

/** Copy mutable Admission collections before crossing into the durable Execution aggregate. */
export function toTaskRunContractSnapshot(contract: TaskRunContract): TaskRunContractSnapshot {
  return {
    ...contract,
    objectives: contract.objectives.map((objective) => ({ ...objective })),
    acceptanceCriteria: [...contract.acceptanceCriteria],
    nonGoals: [...contract.nonGoals],
    sourceInboxIds: [...contract.sourceInboxIds],
    executionPolicy: contract.executionPolicy ? { ...contract.executionPolicy } : undefined,
  };
}

export function toTaskRunLaunchSpec(input: {
  sessionId: string;
  goal: string;
  requestId: string;
  contract?: TaskRunContract | null;
}): TaskRunLaunchSpec {
  return {
    sessionRef: input.sessionId,
    goal: input.goal,
    requestId: input.requestId,
    contract: input.contract ? toTaskRunContractSnapshot(input.contract) : null,
  };
}
