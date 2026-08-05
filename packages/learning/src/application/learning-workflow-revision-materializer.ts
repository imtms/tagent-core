import {
  createWorkflowRevisionDraft,
  type MaterializedWorkflowRevision,
  type MaterializeWorkflowRevisionInput,
  type WorkflowRevisionMaterializerPort,
} from "@tagent/governance";
import type { WorkflowSpec } from "../domain/workflow-types.js";
import {
  applyWorkflowSpecPatch,
  sanitizeWorkflowIds,
  sanitizeWorkflowSpec,
  workflowSpecHash,
  workflowSpecPatchHash,
} from "../domain/workflow-spec.js";

const redact = (value: string) => value
  .replace(/(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, "[REDACTED_SECRET]")
  .replace(/\b(?:password|passwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");

function evidenceIds(evidenceJson: string): string[] {
  const parsed: unknown = JSON.parse(evidenceJson || "[]");
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Workflow proposal evidence must be a string array");
  }
  return sanitizeWorkflowIds(parsed);
}

/** Pure Learning-owned conversion from an approved proposal to Governance's opaque revision draft. */
export class LearningWorkflowRevisionMaterializer implements WorkflowRevisionMaterializerPort {
  materialize(input: MaterializeWorkflowRevisionInput): MaterializedWorkflowRevision {
    const storedBase = JSON.parse(input.baseRevision.specJson) as Partial<WorkflowSpec> & {
      counterexampleIds?: string[];
    };
    const baseSpec = sanitizeWorkflowSpec(storedBase as WorkflowSpec);
    const baseSpecHash = workflowSpecHash(baseSpec);
    if (input.proposal.workflowId !== input.baseRevision.workflowId
      || input.proposal.baseRevisionId !== input.baseRevision.revisionId
      || input.proposal.baseSpecHash !== baseSpecHash
      || input.baseRevision.specHash !== baseSpecHash) {
      throw new Error("Workflow proposal base revision hash validation failed");
    }
    const patch = JSON.parse(input.proposal.patchJson || "{}") as Partial<WorkflowSpec>;
    const proposed = applyWorkflowSpecPatch(baseSpec, patch);
    const resultSpecHash = workflowSpecHash(proposed);
    if (resultSpecHash === baseSpecHash || input.proposal.patchHash !== workflowSpecPatchHash(patch)) {
      throw new Error("Workflow proposal result hash validation failed");
    }
    const revisionValue = {
      specJson: JSON.stringify({
        ...proposed,
        counterexampleIds: sanitizeWorkflowIds(storedBase.counterexampleIds ?? []),
      }),
      specHash: resultSpecHash,
      sourceType: "user_correction",
      sourceEvidenceJson: JSON.stringify(evidenceIds(input.proposal.evidenceJson)),
      confidence: input.baseRevision.confidence,
      changeSummary: redact(input.proposal.reason).slice(0, 2000),
      createdAt: input.timestamp,
    };
    const draft = createWorkflowRevisionDraft({
      workflowId: input.proposal.workflowId,
      proposalId: input.proposal.proposalId,
      baseRevisionId: input.baseRevision.revisionId,
      baseSpecHash,
      proposalPatchHash: input.proposal.patchHash,
      resultSpecHash,
      value: revisionValue,
    });
    return Object.freeze({
      revisionId: input.revisionId,
      workflowId: input.proposal.workflowId,
      proposalId: input.proposal.proposalId,
      baseRevisionId: input.baseRevision.revisionId,
      baseSpecHash,
      proposalPatchHash: input.proposal.patchHash,
      resultSpecHash,
      draft,
    });
  }
}
