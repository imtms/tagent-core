import type { CompletionGate, GateEvaluation } from "../domain/index.js";
import type { GovernanceCompletionRunView } from "./governance-views.js";

export interface GateEvaluationRepository {
  recordGateEvaluation(gate: GateEvaluation): GateEvaluation;
  listLatestGateEvaluations(runId: string): GateEvaluation[];
  evaluateGate(run: GovernanceCompletionRunView): CompletionGate;
}
