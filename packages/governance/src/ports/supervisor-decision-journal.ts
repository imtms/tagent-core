import type { SupervisorDecision } from "../domain/index.js";

export interface SupervisorContinuationReconciliation {
  runId: string;
  decisionId: string;
}

export interface SupervisorDecisionJournal {
  recordSupervisorDecision(decision: SupervisorDecision): SupervisorDecision;
  listSupervisorDecisions(runId: string, attempt?: number): SupervisorDecision[];
  updateSupervisorDecision(
    id: string,
    status: SupervisorDecision["status"],
    error?: string,
  ): { runId: string } | undefined;
  listSupervisorContinuationsNeedingReconcile(): SupervisorContinuationReconciliation[];
  reconcileSupervisorDecisionStatuses(): { executed: number; superseded: number };
}
