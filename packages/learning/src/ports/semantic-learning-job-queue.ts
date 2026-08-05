import type { RunId } from "@tagent/execution/domain";

export type SemanticLearningJobKind = "user_message" | "workflow_eligibility" | "feedback_attribution";

export interface SemanticLearningJob {
  id: string;
  kind: SemanticLearningJobKind;
  runId?: RunId;
  attempt?: number;
  idempotencyKey: string;
  payloadJson: string;
  status: string;
  attempts: number;
  nextRetryAt: number;
  error: string;
  createdAt: number;
  updatedAt: number;
  leaseOwner: string;
  leaseToken: string;
  leaseUntil: number;
  fence: number;
}

export interface SemanticLearningJobQueue {
  enqueueSemanticLearningJob(
    kind: SemanticLearningJobKind,
    payload: Record<string, unknown>,
    idempotencyKey: string,
    runId?: RunId,
    attempt?: number,
  ): unknown;
  claimSemanticLearningJobs(
    owner: string,
    kinds: SemanticLearningJobKind[],
    limit?: number,
    leaseMs?: number,
  ): SemanticLearningJob[];
  renewSemanticLearningJob(id: string, owner: string, token: string, fence: number, leaseMs?: number): boolean;
  completeSemanticLearningJob(id: string, owner: string, token: string, fence: number): boolean;
  failSemanticLearningJob(
    id: string,
    owner: string,
    token: string,
    fence: number,
    attempts: number,
    error: string,
  ): { attempts: number; status: string; nextRetryAt: number; changed: boolean };
}
