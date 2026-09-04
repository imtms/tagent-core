import type { AcceptedUncertainty } from "../domain/index.js";

export interface AcceptUncertaintyInput {
  id: string;
  runId: string;
  criterionId: string;
  actorId: string;
  rationale: string;
  scope: string;
  evidenceRefs: string[];
  expiresAt: number | null;
  createdAt: number;
}

export interface AcceptedUncertaintyRepository {
  acceptUncertainty(input: AcceptUncertaintyInput): AcceptedUncertainty;
  listAcceptedUncertainties(runId: string, activeAt?: number): AcceptedUncertainty[];
}
