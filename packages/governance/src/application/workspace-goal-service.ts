import { createHash } from "node:crypto";
import type {
  CreateWorkspaceGoalInput,
  LinkWorkspaceGoalEvidenceInput,
  LinkWorkspaceGoalRunInput,
  WorkspaceGoal,
  WorkspaceGoalDecisionInput,
  WorkspaceGoalNextAction,
  WorkspaceGoalPlan,
  WorkspaceGoalStatus,
} from "../domain/workspace-goal.js";
import type { WorkspaceGoalRepository } from "../ports/workspace-goal-repository.js";

export class WorkspaceGoalService {
  constructor(private readonly goals: WorkspaceGoalRepository) {}

  create(input: CreateWorkspaceGoalInput): WorkspaceGoal {
    return this.goals.createGoal({
      ...input,
      workspaceId: required(input.workspaceId, "workspaceId", 300),
      createdBy: required(input.createdBy, "createdBy", 300),
      idempotencyKey: input.idempotencyKey?.trim() || undefined,
      definition: validateDefinition(input.definition),
    });
  }

  list(workspaceId: string) {
    return this.goals.listGoals(required(workspaceId, "workspaceId", 300));
  }

  get(goalId: string) {
    return this.goals.getGoal(required(goalId, "goalId", 300));
  }

  reviseDefinition(goalId: string, definition: CreateWorkspaceGoalInput["definition"], createdBy: string) {
    return this.goals.addDefinitionRevision(required(goalId, "goalId", 300), validateDefinition(definition), required(createdBy, "createdBy", 300));
  }

  addPlan(goalId: string, content: WorkspaceGoalPlan, sourceArtifactId: string | null, createdBy: string) {
    return this.goals.addPlanRevision(required(goalId, "goalId", 300), validatePlan(content), sourceArtifactId?.trim() || null, required(createdBy, "createdBy", 300));
  }

  decide(input: WorkspaceGoalDecisionInput) {
    return this.goals.decideGoal({
      ...input,
      goalId: required(input.goalId, "goalId", 300),
      requestId: input.requestId?.trim() || undefined,
      targetRevisionId: required(input.targetRevisionId, "targetRevisionId", 300),
      targetHash: required(input.targetHash, "targetHash", 128),
      actorId: required(input.actorId, "actorId", 300),
      reason: input.reason?.trim() || "",
      approvedItemIds: uniqueStrings(input.approvedItemIds ?? [], "approvedItemIds", 200),
    });
  }

  linkRun(input: LinkWorkspaceGoalRunInput) {
    return this.goals.linkRun({
      ...input,
      goalId: required(input.goalId, "goalId", 300),
      runId: required(input.runId, "runId", 300),
      goalRevision: positiveInteger(input.goalRevision, "goalRevision"),
      planRevisionId: input.planRevisionId?.trim() || null,
      approvedItemIds: uniqueStrings(input.approvedItemIds ?? [], "approvedItemIds", 200),
      criterionKeys: uniqueStrings(input.criterionKeys ?? [], "criterionKeys", 200),
    });
  }

  linkEvidence(input: LinkWorkspaceGoalEvidenceInput) {
    return this.goals.linkEvidence({
      ...input,
      goalId: required(input.goalId, "goalId", 300),
      requestId: input.requestId?.trim() || undefined,
      runId: required(input.runId, "runId", 300),
      criterionKey: required(input.criterionKey, "criterionKey", 200),
      goalRevision: positiveInteger(input.goalRevision, "goalRevision"),
      checkKey: input.checkKey?.trim() || null,
      artifactId: input.artifactId?.trim() || null,
      operationId: input.operationId?.trim() || null,
      sourceDigest: input.sourceDigest?.trim() || undefined,
      status: input.status ?? "valid",
    });
  }
}

export function workspaceGoalNextAction(input: {
  status: WorkspaceGoalStatus;
  hasDefinition: boolean;
  hasApprovedDefinition: boolean;
  hasPlan: boolean;
  hasApprovedPlan: boolean;
  currentRunId: string | null;
  requiredCriteria: number;
  verifiedCriteria: number;
}): WorkspaceGoalNextAction {
  if (["completed", "cancelled"].includes(input.status)) return action("none", "view_result", "Goal ended", "Review the result and evidence.", "View result");
  if (input.status === "paused") return action("user", "resume", "Goal is paused", "Resume when you are ready to continue.", "Resume Goal");
  if (!input.hasDefinition || !input.hasApprovedDefinition) return action("user", "review_goal", "Review this Goal", "Confirm the long-term outcome before planning any source changes.", "Review Goal");
  if (!input.hasPlan) return action("user", "create_plan", "Create a plan", "Use a read-only TaskRun to prepare a bounded plan.", "Create plan");
  if (!input.hasApprovedPlan) return action("user", "review_plan", "Review the current plan", "Choose exactly which plan items may be run.", "Review plan");
  if (input.currentRunId) return action("system", "view_running_task", "A TaskRun is in progress", "The Goal is currently advancing through one bounded TaskRun.", "View task");
  if (input.requiredCriteria > 0 && input.verifiedCriteria >= input.requiredCriteria) return action("user", "view_result", "Verified criteria are ready", "Review the evidence and confirm closure.", "Confirm closure");
  return action("user", "run_task", "Run the next approved item", "Start one bounded TaskRun from the approved plan slice.", "Run next item");
}

export function workspaceGoalContentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function action(actor: WorkspaceGoalNextAction["actor"], kind: WorkspaceGoalNextAction["kind"], title: string, explanation: string, primaryActionLabel: string): WorkspaceGoalNextAction {
  return { actor, kind, title, explanation, primaryActionLabel };
}

function validateDefinition(input: CreateWorkspaceGoalInput["definition"]): CreateWorkspaceGoalInput["definition"] {
  if (!input || typeof input !== "object") throw new Error("definition is required");
  const criteria = input.criteria?.map((criterion, index) => ({
    key: required(criterion.key, `criteria[${index}].key`, 200),
    title: required(criterion.title, `criteria[${index}].title`, 2_000),
    required: criterion.required !== false,
  })) ?? [];
  if (!criteria.length) throw new Error("at least one criterion is required");
  if (criteria.length > 100 || new Set(criteria.map((item) => item.key)).size !== criteria.length) throw new Error("criterion keys must be unique and cannot exceed 100 items");
  return {
    title: required(input.title, "title", 200),
    outcome: required(input.outcome, "outcome", 4_000),
    scope: uniqueStrings(input.scope ?? [], "scope", 100, 2_000),
    nonGoals: uniqueStrings(input.nonGoals ?? [], "nonGoals", 100, 2_000),
    criteria,
    completionPolicy: "user_confirm",
  };
}

function validatePlan(input: WorkspaceGoalPlan): WorkspaceGoalPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("plan is required");
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) throw new Error("plan items must contain between 1 and 50 items");
  const items = input.items.map((item, index) => ({
    id: required(item?.id, `items[${index}].id`, 200),
    title: required(item?.title, `items[${index}].title`, 500),
    outcome: required(item?.outcome, `items[${index}].outcome`, 2_000),
    verification: required(item?.verification, `items[${index}].verification`, 2_000),
  }));
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error("plan item ids must be unique");
  return { summary: required(input.summary, "summary", 4_000), items };
}

function uniqueStrings(value: string[], name: string, maxItems: number, maxLength = 300): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} must be an array with at most ${maxItems} items`);
  const normalized = value.map((item, index) => required(item, `${name}[${index}]`, maxLength));
  return [...new Set(normalized)];
}

function required(value: string | undefined, name: string, maxLength: number): string {
  const text = value?.trim() ?? "";
  if (!text) throw new Error(`${name} is required`);
  if (text.length > maxLength) throw new Error(`${name} cannot exceed ${maxLength} characters`);
  return text;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
