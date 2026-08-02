import { createHash, randomUUID } from "node:crypto";
import type { Store } from "../store/store.js";
import type { ContextManifestItem, RunStatus, TaskRun } from "../core/types.js";

export type WorkflowStatus = "candidate" | "active" | "suspended" | "deprecated";
export type WorkflowSourceType = "explicit_user" | "task_experience" | "task_failure" | "user_correction";
export type WorkflowFeedbackSignal = "successful" | "failed" | "corrected" | "harmful" | "helpful";

export interface WorkflowStep { stepId: string; instruction: string; required: boolean; expectedArtifact?: string; failureHandling?: string }
export interface WorkflowVerification { check: string; required: boolean; successCondition: string }
export interface WorkflowValueContract { name: string; description: string; required: boolean; schema?: string }
export interface WorkflowSpec {
  name: string;
  intent: string;
  cueTerms: string[];
  applicability: string[];
  nonApplicability: string[];
  preconditions: string[];
  inputContract: WorkflowValueContract[];
  outputContract: WorkflowValueContract[];
  steps: WorkflowStep[];
  verification: WorkflowVerification[];
  requiredCapabilities: string[];
  riskClass: "low" | "medium" | "high";
}
export interface WorkflowRevision extends WorkflowSpec {
  id: string; workflowId: string; revision: number; sourceType: WorkflowSourceType;
  sourceEvidenceIds: string[]; counterexampleIds: string[]; confidence: number; changeSummary: string; createdAt: number;
}
export interface WorkflowDefinition {
  id: string; scopeId: string; status: WorkflowStatus; activeRevisionId: string | null;
  createdAt: number; updatedAt: number; revision?: WorkflowRevision;
}
export interface WorkflowRecall {
  promptSection: string;
  contextItems: ContextManifestItem[];
  workflows: Array<{ definition: WorkflowDefinition; revision: WorkflowRevision; score: number; reasons: string[]; bindingId: string }>;
}

const now = () => Date.now();
const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const terms = (value: string) => [...new Set(normalize(value).split(/\s+/).filter((item) => item.length >= 2))];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const redact = (value: string) => value
  .replace(/(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, "[REDACTED_SECRET]")
  .replace(/\b(?:password|passwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");

export class WorkflowService {
  constructor(private readonly store: Store) {}

  setRunLearningPolicy(runId: string, policy: "allow" | "metadata_only" | "deny", reason = "user_requested") {
    this.store.db.prepare(`INSERT INTO run_learning_policies (run_id, policy, reason, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET policy=excluded.policy, reason=excluded.reason, updated_at=excluded.updated_at`)
      .run(runId, policy, reason, now());
    return this.getRunLearningPolicy(runId);
  }

  getRunLearningPolicy(runId: string) {
    return this.store.db.prepare("SELECT run_id as runId, policy, reason, updated_at as updatedAt FROM run_learning_policies WHERE run_id = ?").get(runId) as { runId: string; policy: "allow" | "metadata_only" | "deny"; reason: string; updatedAt: number } | undefined
      ?? { runId, policy: "allow" as const, reason: "default", updatedAt: 0 };
  }

  teach(scopeId: string, spec: WorkflowSpec, sourceId: string, activate = false) {
    return this.createWorkflow(scopeId, sanitizeSpec(spec), "explicit_user", sanitizeIds([sourceId]), activate ? "active" : "candidate", 0.9, "Explicit user teaching");
  }

  recordExperience(input: { scopeId: string; runId?: string; attempt?: number; sourceType: WorkflowSourceType; taskSignature: string; procedureSummary: string; checksPassed?: string[]; checksFailed?: string[]; sourceRefs?: string[]; learnPolicy?: "allow" | "metadata_only" | "deny" }) {
    if (input.learnPolicy === "deny") return undefined;
    const safeSummary = input.learnPolicy === "metadata_only" ? "[metadata only]" : redact(input.procedureSummary).slice(0, 12_000);
    const safeSignature = normalize(redact(input.taskSignature)).slice(0, 1000);
    const safeChecksPassed = input.learnPolicy === "metadata_only" ? [] : sanitizeIds(input.checksPassed ?? []);
    const safeChecksFailed = input.learnPolicy === "metadata_only" ? [] : sanitizeIds(input.checksFailed ?? []);
    const safeSourceRefs = sanitizeIds(input.sourceRefs ?? []);
    const observationHash = hash({ runId: input.runId, attempt: input.attempt, sourceType: input.sourceType, taskSignature: safeSignature, procedureSummary: safeSummary });
    const id = randomUUID();
    this.store.db.prepare(`INSERT OR IGNORE INTO experience_observations
      (id, scope_id, run_id, attempt, source_type, task_signature, procedure_summary, checks_passed_json, checks_failed_json, source_refs_json, learn_policy, observation_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, redact(input.scopeId).slice(0, 500), input.runId ?? null, input.attempt ?? null, input.sourceType, safeSignature, safeSummary,
        JSON.stringify(safeChecksPassed), JSON.stringify(safeChecksFailed), JSON.stringify(safeSourceRefs), input.learnPolicy ?? "allow", observationHash, now());
    return this.store.db.prepare("SELECT id FROM experience_observations WHERE observation_hash = ?").get(observationHash) as { id: string };
  }

  projectRun(run: TaskRun, outcome: RunStatus) {
    const policy = this.getRunLearningPolicy(run.id);
    if (policy.policy === "deny") return undefined;
    const completedWithEvidence = outcome === "completed" && run.checks.filter((check) => check.required).every((check) => check.status === "passed" && !check.stale);
    const sourceType: WorkflowSourceType = completedWithEvidence ? "task_experience" : "task_failure";
    const plan = run.plan.filter((item) => item.status === "done").sort((a, b) => a.position - b.position);
    if (!plan.length && completedWithEvidence) return undefined;
    const observation = this.recordExperience({
      scopeId: run.sessionId,
      runId: run.id,
      attempt: run.attempt,
      sourceType,
      taskSignature: run.contract?.summary ?? run.goal,
      procedureSummary: plan.length ? plan.map((item, index) => `${index + 1}. ${item.title}`).join("\n") : run.blockedReason,
      checksPassed: run.checks.filter((item) => item.status === "passed" && !item.stale).map((item) => item.title),
      checksFailed: run.checks.filter((item) => item.status === "failed" || item.stale).map((item) => item.title),
      sourceRefs: [`run:${run.id}:attempt:${run.attempt}`],
      learnPolicy: policy.policy,
    });
    if (completedWithEvidence) this.distillRepeatedExperience(run.sessionId, normalize(run.contract?.summary ?? run.goal));
    return observation;
  }

  distillRepeatedExperience(scopeId: string, taskSignature: string) {
    const rows = this.store.db.prepare(`SELECT id, procedure_summary as procedureSummary, checks_passed_json as checksPassedJson
      FROM experience_observations WHERE scope_id = ? AND task_signature = ? AND source_type = 'task_experience' AND learn_policy = 'allow'
      ORDER BY created_at`).all(scopeId, taskSignature) as Array<{ id: string; procedureSummary: string; checksPassedJson: string }>;
    if (rows.length < 2) return undefined;
    const evidenceIds = rows.map((row) => row.id);
    const evidenceSetHash = hash(evidenceIds.sort());
    const existing = this.store.db.prepare("SELECT workflow_id as workflowId FROM workflow_distillations WHERE evidence_set_hash = ?").get(evidenceSetHash) as { workflowId: string } | undefined;
    if (existing) return this.getWorkflow(existing.workflowId);
    const first = rows[0];
    const stepLines = first.procedureSummary.split(/\n+/).map((line) => line.replace(/^\d+[.)]\s*/, "").trim()).filter(Boolean);
    const cueTerms = terms(taskSignature).slice(0, 16);
    const checks = [...new Set(rows.flatMap((row) => JSON.parse(row.checksPassedJson) as string[]))].slice(0, 12);
    const workflow = this.createWorkflow(scopeId, {
      name: taskSignature.slice(0, 120), intent: taskSignature, cueTerms,
      applicability: [taskSignature], nonApplicability: [], preconditions: [], inputContract: [], outputContract: [],
      steps: stepLines.map((instruction, index) => ({ stepId: `step-${index + 1}`, instruction, required: true })),
      verification: checks.map((check) => ({ check, required: true, successCondition: "check passes" })),
      requiredCapabilities: [], riskClass: "low",
    }, "task_experience", evidenceIds, "candidate", Math.min(0.85, 0.55 + rows.length * 0.1), `Distilled from ${rows.length} independent TaskRuns`);
    this.store.db.prepare("INSERT INTO workflow_distillations (evidence_set_hash, workflow_id, created_at) VALUES (?, ?, ?)").run(evidenceSetHash, workflow.id, now());
    return workflow;
  }

  createWorkflow(scopeId: string, spec: WorkflowSpec, sourceType: WorkflowSourceType, evidenceIds: string[], status: WorkflowStatus = "candidate", confidence = 0.7, changeSummary = "Initial revision", counterexampleIds: string[] = []) {
    const timestamp = now(); const workflowId = randomUUID(); const revisionId = randomUUID();
    const transaction = this.store.db.transaction(() => {
      this.store.db.prepare("INSERT INTO workflow_definitions (id, scope_id, status, active_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(workflowId, redact(scopeId).slice(0, 500), status, status === "active" ? revisionId : null, timestamp, timestamp);
      this.store.db.prepare(`INSERT INTO workflow_revisions
        (id, workflow_id, revision, spec_json, source_type, source_evidence_json, confidence, change_summary, created_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`)
        .run(revisionId, workflowId, JSON.stringify({ ...sanitizeSpec(spec), counterexampleIds: sanitizeIds(counterexampleIds) }), sourceType, JSON.stringify(sanitizeIds(evidenceIds)), confidence, redact(changeSummary).slice(0, 2000), timestamp);
    }); transaction();
    return this.getWorkflow(workflowId)!;
  }

  revise(workflowId: string, patch: Partial<WorkflowSpec>, sourceType: WorkflowSourceType, evidenceIds: string[], changeSummary: string) {
    const current = this.getWorkflow(workflowId); if (!current?.revision) throw new Error("Workflow not found");
    const revision = (this.store.db.prepare("SELECT COALESCE(MAX(revision), 0) as revision FROM workflow_revisions WHERE workflow_id = ?").get(workflowId) as { revision: number }).revision + 1;
    const id = randomUUID(); const spec = sanitizeSpec({ ...pickSpec(current.revision), ...patch });
    this.store.db.prepare(`INSERT INTO workflow_revisions (id, workflow_id, revision, spec_json, source_type, source_evidence_json, confidence, change_summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, workflowId, revision, JSON.stringify({ ...spec, counterexampleIds: current.revision.counterexampleIds }), sourceType, JSON.stringify(sanitizeIds(evidenceIds)), current.revision.confidence, redact(changeSummary).slice(0, 2000), now());
    return this.getRevision(id)!;
  }

  activate(workflowId: string, revisionId?: string) {
    const revision = revisionId ? this.getRevision(revisionId) : this.listRevisions(workflowId).at(-1);
    if (!revision || revision.workflowId !== workflowId) throw new Error("Workflow revision not found");
    this.store.db.prepare("UPDATE workflow_definitions SET status='active', active_revision_id=?, updated_at=? WHERE id=?").run(revision.id, now(), workflowId);
    return this.getWorkflow(workflowId)!;
  }
  suspend(workflowId: string, reason = "governance") { this.setStatus(workflowId, "suspended", reason); return this.getWorkflow(workflowId)!; }
  disable(workflowId: string, reason = "user_requested") { return this.suspend(workflowId, reason); }
  rollback(workflowId: string, revisionId: string) { return this.activate(workflowId, revisionId); }
  setBindingMode(bindingId: string, mode: "suggested" | "adopted" | "partially_adopted" | "rejected") {
    const result = this.store.db.prepare("UPDATE workflow_bindings SET application_mode = ? WHERE id = ?").run(mode, bindingId);
    if (result.changes !== 1) throw new Error("Workflow binding not found");
    return { bindingId, mode };
  }

  forget(workflowId: string) {
    const transaction = this.store.db.transaction(() => {
      this.store.db.prepare("DELETE FROM workflow_revision_proposals WHERE workflow_id = ?").run(workflowId);
      this.store.db.prepare("DELETE FROM workflow_feedback WHERE workflow_id = ?").run(workflowId);
      this.store.db.prepare("DELETE FROM workflow_application_receipts WHERE binding_id IN (SELECT id FROM workflow_bindings WHERE workflow_id = ?)").run(workflowId);
      this.store.db.prepare("DELETE FROM workflow_bindings WHERE workflow_id = ?").run(workflowId);
      this.store.db.prepare("DELETE FROM workflow_distillations WHERE workflow_id = ?").run(workflowId);
      this.store.db.prepare("DELETE FROM workflow_status_history WHERE workflow_id = ?").run(workflowId);
      this.store.db.prepare("DELETE FROM workflow_revisions WHERE workflow_id = ?").run(workflowId);
      return this.store.db.prepare("DELETE FROM workflow_definitions WHERE id = ?").run(workflowId).changes === 1;
    });
    return transaction();
  }

  private setStatus(workflowId: string, status: WorkflowStatus, reason: string) {
    const current = this.getWorkflow(workflowId); if (!current) throw new Error("Workflow not found");
    this.store.db.prepare("UPDATE workflow_definitions SET status=?, active_revision_id=CASE WHEN ?='active' THEN active_revision_id ELSE NULL END, updated_at=? WHERE id=?").run(status, status, now(), workflowId);
    this.store.db.prepare("INSERT INTO workflow_status_history (id, workflow_id, previous_status, next_status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), workflowId, current.status, status, reason, now());
  }

  recordRunApplications(run: TaskRun) {
    const bindings = this.store.db.prepare(`SELECT id, workflow_id as workflowId, revision_id as revisionId, application_mode as applicationMode
      FROM workflow_bindings WHERE run_id = ? AND attempt = ?`).all(run.id, run.attempt) as Array<{ id: string; workflowId: string; revisionId: string; applicationMode: string }>;
    const passed = run.checks.filter((check) => check.required && check.status === "passed" && !check.stale).length;
    const failed = run.checks.filter((check) => check.required && (check.status === "failed" || check.stale)).length;
    for (const binding of bindings) {
      const adopted = binding.applicationMode === "adopted" || binding.applicationMode === "partially_adopted";
      const attributionLevel = adopted ? failed === 0 && passed > 0 ? "verified_contribution" : "adopted" : "exposed";
      this.store.db.prepare(`INSERT OR IGNORE INTO workflow_application_receipts
        (id, binding_id, run_id, attempt, task_outcome, required_checks_passed, required_checks_failed, attribution_level, receipt_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
        .run(randomUUID(), binding.id, run.id, run.attempt, run.status, passed, failed, attributionLevel, now());
      if (!adopted) continue;
      const signal: WorkflowFeedbackSignal = run.status === "completed" && failed === 0 && passed > 0 ? "successful" : failed > 0 ? "failed" : run.status === "cancelled" ? "failed" : "failed";
      this.feedback({ workflowId: binding.workflowId, revisionId: binding.revisionId, runId: run.id, attempt: run.attempt, signal, idempotencyKey: `workflow-application:${binding.id}:v1`, adopted: true, verified: attributionLevel === "verified_contribution" });
    }
  }

  feedback(input: { workflowId: string; revisionId: string; runId: string; attempt: number; signal: WorkflowFeedbackSignal; idempotencyKey: string; note?: string; adopted?: boolean; verified?: boolean }) {
    const weights: Record<WorkflowFeedbackSignal, number> = { successful: 1, helpful: 0.75, failed: -1, corrected: -1.5, harmful: -2 };
    const id = randomUUID();
    this.store.db.prepare(`INSERT OR IGNORE INTO workflow_feedback
      (id, workflow_id, revision_id, run_id, attempt, signal, weight, adopted, verified, idempotency_key, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.workflowId, input.revisionId, input.runId, input.attempt, input.signal, weights[input.signal], Number(input.adopted ?? true), Number(input.verified ?? false), input.idempotencyKey, redact(input.note ?? ""), now());
    const receipt = this.store.db.prepare("SELECT * FROM workflow_feedback WHERE idempotency_key = ?").get(input.idempotencyKey) as Record<string, unknown>;
    if (String(receipt.id) !== id) return receipt;
    if (["corrected", "harmful"].includes(input.signal)) {
      const definition = this.getWorkflow(input.workflowId);
      if (definition?.status === "active") this.suspend(input.workflowId, `automatic_${input.signal}`);
      this.store.db.prepare(`INSERT OR IGNORE INTO workflow_revision_proposals
        (id, workflow_id, base_revision_id, reason, evidence_json, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'candidate', ?)`)
        .run(randomUUID(), input.workflowId, input.revisionId, input.note ?? input.signal, JSON.stringify([input.idempotencyKey]), now());
    }
    return receipt;
  }

  recall(scopeId: string, cue: string, runId: string, attempt: number, availableCapabilities: string[] = []): WorkflowRecall {
    const cueSet = new Set(terms(cue));
    const definitions = this.listWorkflows(scopeId).filter((item) => item.status === "active" && item.revision);
    const selected = definitions.flatMap((definition) => {
      const revision = definition.revision!;
      const normalizedCue = normalize(cue);
      if (revision.nonApplicability.some((rule) => normalizedCue.includes(normalize(rule)))) return [];
      const capabilitySet = new Set(availableCapabilities.map(normalize));
      if (revision.requiredCapabilities.some((capability) => !capabilitySet.has(normalize(capability)))) return [];
      const trigger = new Set([...revision.cueTerms, ...terms(revision.intent)]);
      const overlap = [...trigger].filter((term) => cueSet.has(normalize(term))).length;
      const phrase = revision.applicability.some((rule) => normalizedCue.includes(normalize(rule)) || normalize(rule).includes(normalizedCue));
      const score = Math.min(1, overlap / Math.max(2, trigger.size) + (phrase ? 0.45 : 0) + revision.confidence * 0.2);
      if (score < 0.2) return [];
      const reasons = [phrase ? "applicability rule matched" : "", overlap ? `${overlap} trigger term(s) matched` : "", `confidence ${revision.confidence.toFixed(2)}`].filter(Boolean);
      const bindingId = randomUUID();
      this.store.db.prepare(`INSERT OR IGNORE INTO workflow_bindings
        (id, run_id, attempt, workflow_id, revision_id, selector_version, relevance_score, selected_reason_json, application_mode, created_at)
        VALUES (?, ?, ?, ?, ?, 'workflow-selector-v1', ?, ?, 'suggested', ?)`)
        .run(bindingId, runId, attempt, definition.id, revision.id, score, JSON.stringify(reasons), now());
      const persisted = this.store.db.prepare("SELECT id FROM workflow_bindings WHERE run_id=? AND attempt=? AND workflow_id=? AND revision_id=?").get(runId, attempt, definition.id, revision.id) as { id: string };
      return [{ definition, revision, score, reasons, bindingId: persisted.id }];
    }).sort((a, b) => b.score - a.score).slice(0, 3);
    const promptSection = selected.length ? `<workflow_guidance>\n${selected.map(({ revision, reasons }) => [
      `Workflow: ${revision.name}@${revision.revision}`,
      `Why recalled: ${reasons.join("; ")}`,
      `Applicable when: ${revision.applicability.join("; ") || revision.intent}`,
      revision.nonApplicability.length ? `Do not apply when: ${revision.nonApplicability.join("; ")}` : "",
      `Suggested steps:\n${revision.steps.map((step) => `- [${step.required ? "required" : "optional"}] ${step.instruction}`).join("\n")}`,
      revision.inputContract.length ? `Inputs:\n${revision.inputContract.map((item) => `- ${item.name}${item.required ? " (required)" : ""}: ${item.description}`).join("\n")}` : "",
      revision.outputContract.length ? `Expected outputs:\n${revision.outputContract.map((item) => `- ${item.name}${item.required ? " (required)" : ""}: ${item.description}`).join("\n")}` : "",
      revision.verification.length ? `Verification:\n${revision.verification.map((item) => `- ${item.check}: ${item.successCondition}`).join("\n")}` : "",
      "This workflow is guidance only and grants no additional capability or approval.",
    ].filter(Boolean).join("\n")).join("\n\n")}\n</workflow_guidance>` : "";
    return {
      promptSection,
      workflows: selected,
      contextItems: selected.map(({ definition, revision, score, reasons, bindingId }) => ({ kind: "workflow_revision", sourceId: revision.id, selected: true, reason: reasons.join("; "), estimatedTokens: Math.ceil(JSON.stringify(revision).length / 4), metadata: { workflowId: definition.id, revision: revision.revision, score, bindingId, riskClass: revision.riskClass } })),
    };
  }

  listWorkflows(scopeId: string) {
    const rows = this.store.db.prepare("SELECT id, scope_id as scopeId, status, active_revision_id as activeRevisionId, created_at as createdAt, updated_at as updatedAt FROM workflow_definitions WHERE scope_id = ? ORDER BY updated_at DESC").all(scopeId) as WorkflowDefinition[];
    return rows.map((row) => ({ ...row, revision: row.activeRevisionId ? this.getRevision(row.activeRevisionId) : this.listRevisions(row.id).at(-1) }));
  }
  getWorkflow(id: string) { const row = this.store.db.prepare("SELECT id, scope_id as scopeId, status, active_revision_id as activeRevisionId, created_at as createdAt, updated_at as updatedAt FROM workflow_definitions WHERE id = ?").get(id) as WorkflowDefinition | undefined; return row ? { ...row, revision: row.activeRevisionId ? this.getRevision(row.activeRevisionId) : this.listRevisions(row.id).at(-1) } : undefined; }
  listRevisions(workflowId: string) { return (this.store.db.prepare("SELECT id FROM workflow_revisions WHERE workflow_id = ? ORDER BY revision").all(workflowId) as Array<{ id: string }>).map((row) => this.getRevision(row.id)!); }
  getRevision(id: string): WorkflowRevision | undefined { const row = this.store.db.prepare("SELECT id, workflow_id as workflowId, revision, spec_json as specJson, source_type as sourceType, source_evidence_json as sourceEvidenceJson, confidence, change_summary as changeSummary, created_at as createdAt FROM workflow_revisions WHERE id = ?").get(id) as { id: string; workflowId: string; revision: number; specJson: string; sourceType: WorkflowSourceType; sourceEvidenceJson: string; confidence: number; changeSummary: string; createdAt: number } | undefined; if (!row) return undefined; const stored = JSON.parse(row.specJson) as Partial<WorkflowSpec> & { counterexampleIds?: string[] }; return { id: row.id, workflowId: row.workflowId, revision: row.revision, ...sanitizeSpec(stored as WorkflowSpec), sourceType: row.sourceType, sourceEvidenceIds: JSON.parse(row.sourceEvidenceJson) as string[], counterexampleIds: sanitizeIds(stored.counterexampleIds ?? []), confidence: row.confidence, changeSummary: row.changeSummary, createdAt: row.createdAt }; }
}

function sanitizeSpec(spec: WorkflowSpec): WorkflowSpec {
  if (!spec.name?.trim() || !spec.intent?.trim() || !spec.steps?.length) throw new Error("Workflow name, intent and at least one step are required");
  return {
    name: redact(spec.name.trim()).slice(0, 160), intent: redact(spec.intent.trim()).slice(0, 1000), cueTerms: (spec.cueTerms ?? []).map(redact).filter(Boolean).slice(0, 32),
    applicability: (spec.applicability ?? []).map(redact).filter(Boolean).slice(0, 20), nonApplicability: (spec.nonApplicability ?? []).map(redact).filter(Boolean).slice(0, 20), preconditions: (spec.preconditions ?? []).map(redact).filter(Boolean).slice(0, 20),
    inputContract: sanitizeContract(spec.inputContract ?? []), outputContract: sanitizeContract(spec.outputContract ?? []),
    steps: spec.steps.slice(0, 40).map((step, index) => ({ stepId: redact(step.stepId || `step-${index + 1}`).slice(0, 160), instruction: redact(step.instruction).slice(0, 2000), required: step.required !== false, expectedArtifact: step.expectedArtifact ? redact(step.expectedArtifact).slice(0, 1000) : undefined, failureHandling: step.failureHandling ? redact(step.failureHandling).slice(0, 1000) : undefined })),
    verification: (spec.verification ?? []).slice(0, 20).map((item) => ({ check: redact(item.check).slice(0, 1000), required: item.required !== false, successCondition: redact(item.successCondition).slice(0, 1000) })),
    requiredCapabilities: (spec.requiredCapabilities ?? []).map(normalize).filter(Boolean).slice(0, 20), riskClass: spec.riskClass ?? "low",
  };
}
function sanitizeContract(items: WorkflowValueContract[]) { return items.slice(0, 20).map((item) => ({ name: redact(item.name ?? "").slice(0, 160), description: redact(item.description ?? "").slice(0, 1000), required: item.required !== false, schema: item.schema ? redact(item.schema).slice(0, 2000) : undefined })).filter((item) => item.name && item.description); }
function sanitizeIds(items: string[]) { return items.map((item) => redact(String(item)).slice(0, 500)).filter(Boolean).slice(0, 100); }
function pickSpec(revision: WorkflowRevision): WorkflowSpec { const { id: _id, workflowId: _workflowId, revision: _revision, sourceType: _sourceType, sourceEvidenceIds: _sourceEvidenceIds, counterexampleIds: _counterexampleIds, confidence: _confidence, changeSummary: _changeSummary, createdAt: _createdAt, ...spec } = revision; return spec; }
