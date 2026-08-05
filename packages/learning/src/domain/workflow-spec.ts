import { createHash } from "node:crypto";
import { stableJson } from "@tagent/governance";
import type { WorkflowRevision, WorkflowSpec, WorkflowValueContract } from "./workflow-types.js";

const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const redact = (value: string) => value
  .replace(/(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, "[REDACTED_SECRET]")
  .replace(/\b(?:password|passwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");

function sanitizeContract(items: WorkflowValueContract[]): WorkflowValueContract[] {
  return items.slice(0, 20).map((item) => ({
    name: redact(item.name ?? "").slice(0, 160),
    description: redact(item.description ?? "").slice(0, 1000),
    required: item.required !== false,
    schema: item.schema ? redact(item.schema).slice(0, 2000) : undefined,
  })).filter((item) => Boolean(item.name && item.description));
}

function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableObject(item)]));
  }
  return value;
}

export function sanitizeWorkflowSpec(spec: WorkflowSpec): WorkflowSpec {
  if (!spec.name?.trim() || !spec.intent?.trim() || !spec.steps?.length) {
    throw new Error("Workflow name, intent and at least one step are required");
  }
  return {
    name: redact(spec.name.trim()).slice(0, 160),
    intent: redact(spec.intent.trim()).slice(0, 1000),
    cueTerms: (spec.cueTerms ?? []).map(redact).filter(Boolean).slice(0, 32),
    applicability: (spec.applicability ?? []).map(redact).filter(Boolean).slice(0, 20),
    nonApplicability: (spec.nonApplicability ?? []).map(redact).filter(Boolean).slice(0, 20),
    preconditions: (spec.preconditions ?? []).map(redact).filter(Boolean).slice(0, 20),
    inputContract: sanitizeContract(spec.inputContract ?? []),
    outputContract: sanitizeContract(spec.outputContract ?? []),
    steps: spec.steps.slice(0, 40).map((step, index) => ({
      stepId: redact(step.stepId || `step-${index + 1}`).slice(0, 160),
      instruction: redact(step.instruction).slice(0, 2000),
      required: step.required !== false,
      expectedArtifact: step.expectedArtifact ? redact(step.expectedArtifact).slice(0, 1000) : undefined,
      failureHandling: step.failureHandling ? redact(step.failureHandling).slice(0, 1000) : undefined,
    })),
    verification: (spec.verification ?? []).slice(0, 20).map((item) => ({
      check: redact(item.check).slice(0, 1000),
      required: item.required !== false,
      successCondition: redact(item.successCondition).slice(0, 1000),
    })),
    requiredCapabilities: (spec.requiredCapabilities ?? []).map(normalize).filter(Boolean).slice(0, 20),
    riskClass: spec.riskClass ?? "low",
  };
}

export function sanitizeWorkflowIds(items: string[]): string[] {
  return items.map((item) => redact(String(item)).slice(0, 500)).filter(Boolean).slice(0, 100);
}

export function workflowSpecHash(spec: WorkflowSpec): string {
  return createHash("sha256")
    .update(JSON.stringify(stableObject(sanitizeWorkflowSpec(spec))))
    .digest("hex");
}

export function workflowSpecPatchPaths(patch: Partial<WorkflowSpec>): string[] {
  if (!patch || Array.isArray(patch) || typeof patch !== "object") return [];
  return Object.keys(patch).filter((key) => (patch as Record<string, unknown>)[key] !== undefined).sort();
}

export function workflowSpecPatchHash(patch: Partial<WorkflowSpec>): string {
  if (!workflowSpecPatchPaths(patch).length) throw new Error("Proposal patch must be non-empty");
  return createHash("sha256").update(stableJson(patch)).digest("hex");
}

export function pickWorkflowSpec(revision: WorkflowRevision): WorkflowSpec {
  const {
    id: _id,
    workflowId: _workflowId,
    revision: _revision,
    sourceType: _sourceType,
    sourceEvidenceIds: _sourceEvidenceIds,
    counterexampleIds: _counterexampleIds,
    confidence: _confidence,
    changeSummary: _changeSummary,
    createdAt: _createdAt,
    ...spec
  } = revision;
  return spec;
}

export function applyWorkflowSpecPatch(base: WorkflowSpec, patch: Partial<WorkflowSpec>): WorkflowSpec {
  if (!workflowSpecPatchPaths(patch).length) throw new Error("Proposal patch must be non-empty");
  return sanitizeWorkflowSpec({ ...base, ...patch });
}
