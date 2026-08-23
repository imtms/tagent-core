import { useEffect, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import {
  Activity, Bot, BrainCircuit, Check, ChevronDown, ChevronRight, Circle, Download, Eye,
  FileText, GripVertical, HelpCircle, Pencil, Send, ShieldAlert, ShieldCheck, Terminal, X,
} from "lucide-react";
import { ICON_SIZE } from "./icon-size";
import {
  api,
  type Artifact,
  type ArtifactContent,
  type ContextManifest,
  type RunEvent,
  type Session,
  type SessionInboxItem,
  type TaskRun,
  type TranscriptItem,
  type UserInputRequest,
} from "./api";
import { Markdown } from "./LazyMarkdown";
import { LiveText } from "./LiveText";
import { formatCount } from "./count-format";
import { deriveCurrentOperation } from "./current-operation";
import { formatRunStatus, formatRunValue, isRedundantRunPhase, runStatusNotice, runStatusTone } from "./run-state";
import { formatCompactDuration, formatConversationDay, formatTime } from "./time-format";
import { LatestRequestAuthority } from "./latest-request";
import { groupExecutionItems, type ExecutionGroup } from "./transcript-projection";
import { useModalFocus } from "./use-modal-focus";
import { userInputValuesForRequest } from "./user-input-state";

export function TAgentMark({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M5 6.5h14M12 6.5V18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="5" cy="6.5" r="2" fill="currentColor" />
    <circle cx="19" cy="6.5" r="2" fill="currentColor" />
    <circle cx="12" cy="18" r="2" fill="currentColor" />
  </svg>;
}

type OperationalTone = "info" | "success" | "warning" | "danger";

function operationalTone(status: string): OperationalTone | undefined {
  if (["failed", "error", "rejected"].includes(status)) return "danger";
  if (["blocked", "stale", "stalled", "waiting"].includes(status)) return "warning";
  if (["running", "in_progress"].includes(status)) return "info";
  if (["completed", "done", "passed"].includes(status)) return "success";
  return undefined;
}

export function ConversationDateDivider({ value }: { value: number }) {
  const label = formatConversationDay(value);
  return <div className="conversation-date-divider" role="separator" aria-label={label}><span>{label}</span></div>;
}

export function WorkspaceRunStatus({ workspace }: { workspace: Session }) {
  const status = workspace.latestRunStatus;
  if (!status) return null;
  const statusText = formatRunStatus(status);
  return <span className="status-label" data-tone={runStatusTone(status)} title={`${statusText}${workspace.latestRunPhase && !isRedundantRunPhase(status, workspace.latestRunPhase) ? ` · ${formatRunValue(workspace.latestRunPhase)}` : ""}`}>
    {status === "running" ? <Activity size={ICON_SIZE.micro} /> : <span className="status-dot" />}
    <span>{statusText}</span>
  </span>;
}

function formatToolArguments(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim() ? value : "";
  if (Array.isArray(value) && value.length === 0) return "";
  if (typeof value === "object" && Object.keys(value).length === 0) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function ToolCall({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  const status = item.isError ? "failed" : item.status;
  const showStatus = !["completed", "done"].includes(status);
  const argumentsText = formatToolArguments(item.arguments);
  const errorMessage = item.error?.message.trim() ?? "";
  const hasResult = Boolean(item.result.trim());
  const resultRepeatsError = Boolean(hasResult && errorMessage && normalizedNotice(item.result) === normalizedNotice(errorMessage));
  const hasDetails = Boolean(argumentsText || errorMessage || (hasResult && !resultRepeatsError));
  const summary = <><Terminal size={ICON_SIZE.sm} /><span className="truncate" title={item.toolName}>{item.toolName}</span>{showStatus && <small data-tone={operationalTone(status)}>{formatRunValue(status)}</small>}</>;
  if (!hasDetails) return <div className="tool-call tool-call-static">{summary}</div>;
  return <details className="tool-call">
    <summary>{summary}<ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
    <div className="tool-call-body">
      {argumentsText && <div><strong>Arguments</strong><pre>{argumentsText}</pre></div>}
      {hasResult && !resultRepeatsError && <div><strong>Result</strong><pre>{item.result}</pre></div>}
      {errorMessage && <div><strong>Error</strong><pre>{errorMessage}{item.error?.code ? `\n\nCode: ${item.error.code}` : ""}</pre></div>}
    </div>
  </details>;
}

function ExecutionGroupView({ group, ordinal }: { group: ExecutionGroup; ordinal: number }) {
  const anchor = group.reasoning ?? group.tools[0] ?? group.output;
  if (!anchor) return null;
  const meta = [
    group.tools.length ? formatCount(group.tools.length, "tool call") : "",
    anchor.attempt > 1 ? `attempt ${anchor.attempt}` : "",
    formatTime(anchor.createdAt),
  ].filter(Boolean).join(" · ");
  const tools = group.tools.length > 0 && <div className="tool-stack" aria-label={`Stage ${ordinal} tool calls`}>{group.tools.map((item) => <ToolCall key={`${item.seq}-${item.index}`} item={item} />)}</div>;
  const output = group.output && <div className="run-step-content"><span data-label>Model output</span><Markdown>{group.output.text}</Markdown></div>;
  if (group.reasoning) return <details className="run-step">
    <summary><BrainCircuit size={ICON_SIZE.sm} /><strong>{group.reasoning.redacted ? "Reasoning unavailable" : `Reasoning ${ordinal}`}</strong><small>{meta}</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
    <div className="run-step-content"><Markdown>{group.reasoning.text}</Markdown></div>
    {tools}{output}
  </details>;
  return <article className="run-step">
    <div className="run-step-meta">{group.tools.length ? <Terminal size={ICON_SIZE.sm} /> : <Bot size={ICON_SIZE.sm} />}<strong>{group.tools.length ? `Execution ${ordinal}` : "Model output"}</strong><small>{meta}</small></div>
    {tools}{output}
  </article>;
}

export function UserInputCard({ request, submitting, onSubmit }: { request: UserInputRequest; submitting: boolean; onSubmit: (values: Record<string, string>) => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>(() => userInputValuesForRequest(request));
  const missing = request.fields.some((field) => field.required && !values[field.key]?.trim());
  const prompt = request.prompt.trim();
  const promptRepeatsOnlyLabel = request.fields.length === 1
    && normalizedNotice(prompt) === normalizedNotice(request.fields[0]?.label ?? "");
  const heading = prompt && !promptRepeatsOnlyLabel ? prompt : "Information needed to continue";
  return <section className="user-input-card" aria-label="TaskRun needs more information">
    <div className="section-heading"><span><HelpCircle size={ICON_SIZE.lg} /><strong>{heading}</strong></span></div>
    <small data-meta>Supplying these answers does not approve external actions.</small>
    <form onSubmit={(event) => { event.preventDefault(); if (!missing && !submitting) void onSubmit(userInputValuesForRequest(request, values)); }}>
      {request.fields.map((field) => {
        const description = field.description?.trim() ?? "";
        const showDescription = Boolean(description
          && normalizedNotice(description) !== normalizedNotice(field.label)
          && normalizedNotice(description) !== normalizedNotice(prompt));
        const placeholder = field.placeholder?.trim() ?? "";
        const showPlaceholder = Boolean(placeholder
          && normalizedNotice(placeholder) !== normalizedNotice(field.label)
          && normalizedNotice(placeholder) !== normalizedNotice(description)
          && normalizedNotice(placeholder) !== normalizedNotice(prompt));
        return <label key={field.key}><span>{field.label}{field.required ? " *" : ""}</span>{field.inputType === "textarea" ? <textarea rows={3} value={values[field.key] ?? ""} placeholder={showPlaceholder ? placeholder : undefined} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} /> : <input value={values[field.key] ?? ""} placeholder={showPlaceholder ? placeholder : undefined} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} />}{showDescription && <small>{description}</small>}</label>;
      })}
      <button className="control" data-variant="primary" type="submit" disabled={missing || submitting}>{submitting ? <Activity className="spin" size={ICON_SIZE.md} /> : <Send size={ICON_SIZE.md} />}{submitting ? "Resuming…" : "Submit and resume"}</button>
    </form>
  </section>;
}

export function ExecutionTimeline({ runId, isRunning, items, events, liveThinking, liveOutput }: { runId: string; isRunning: boolean; items: TranscriptItem[]; events: RunEvent[]; liveThinking: string; liveOutput: string }) {
  const [expanded, setExpanded] = useState(isRunning);
  const bodyRef = useRef<HTMLDivElement>(null);
  const visible = items.filter((item) => item.kind !== "user");
  const groups = groupExecutionItems(visible);
  const completedToolIds = new Set(items.filter((item): item is Extract<TranscriptItem, { kind: "tool" }> => item.kind === "tool").map((item) => item.toolCallId));
  const liveTools = events.filter((event) => event.type.startsWith("tool.") && !completedToolIds.has(String(event.data.toolCallId ?? ""))).reduce<RunEvent[]>((latest, event) => {
    const id = String(event.data.toolCallId ?? event.seq);
    const existing = latest.findIndex((item) => String(item.data.toolCallId ?? item.seq) === id);
    if (existing >= 0) latest[existing] = event; else latest.push(event);
    return latest;
  }, []);
  useEffect(() => { setExpanded(isRunning); }, [runId, isRunning]);
  useEffect(() => {
    if (!isRunning || !expanded) return;
    const frame = requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (body) body.scrollTop = body.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, isRunning, visible.length, liveTools.length, liveThinking, liveOutput, events]);
  if (!visible.length && !liveThinking && !liveOutput && !liveTools.length) return null;
  const hasLiveStage = Boolean(liveThinking || liveOutput || liveTools.length);
  const stageCount = groups.length + Number(hasLiveStage);
  return <section className="execution-timeline" aria-label="Agent execution timeline">
    <button className="execution-timeline-heading" type="button" aria-expanded={expanded} aria-controls={`execution-trace-${runId}`} onClick={() => setExpanded((current) => !current)}>
      <span>{expanded ? <ChevronDown size={ICON_SIZE.sm} /> : <ChevronRight size={ICON_SIZE.sm} />}<Activity size={ICON_SIZE.sm} />Execution trace{isRunning && <i><span className="status-dot pulse" />Live</i>}</span>
      <small>{formatCount(stageCount, "stage")}</small>
    </button>
    {expanded && <div className="execution-timeline-body" id={`execution-trace-${runId}`} ref={bodyRef}>
      {groups.map((group, index) => <ExecutionGroupView key={group.key} group={group} ordinal={index + 1} />)}
      {hasLiveStage && <article className="run-step"><div className="run-step-meta"><Activity size={ICON_SIZE.sm} /><strong>Current stage</strong></div>{liveThinking && <div className="run-step-content"><span data-label>Reasoning</span><LiveText>{liveThinking}</LiveText></div>}{liveTools.length > 0 && <div className="tool-stack">{liveTools.map((event) => { const status = event.type === "tool.started" ? "running" : event.data.isError ? "failed" : "completed"; const toolName = String(event.data.toolName ?? "tool"); return <div className="tool-row" key={`${event.seq}-${event.type}`}><Terminal size={ICON_SIZE.sm} /><strong className="truncate" title={toolName}>{toolName}</strong>{status !== "completed" && <small data-tone={operationalTone(status)}>{formatRunValue(status)}</small>}</div>; })}</div>}{liveOutput && <div className="run-step-content"><span data-label>Model output</span><LiveText>{liveOutput}</LiveText></div>}</article>}
    </div>}
  </section>;
}

function GateFailureRow({ failure, label, title }: {
  failure: { key: string; reason: string };
  label: string;
  title?: string;
}) {
  const formattedLabel = formatRunValue(label);
  const formattedKey = title === undefined ? formatRunValue(failure.key) : title;
  const repeatedKey = formattedKey.toLocaleLowerCase() === formattedLabel.toLocaleLowerCase();
  return <div className="gate-detail">
    {formattedLabel && <span>{formattedLabel}</span>}
    {!repeatedKey && formattedKey && <strong>{formattedKey}</strong>}
    <p>{failure.reason}</p>
  </div>;
}

function foregroundFailureTitle(run: TaskRun, failure: { kind: string; key: string; reason: string }): string {
  const matchedTitle = failure.kind === "check"
    ? run.checks.find((item) => item.key === failure.key)?.title
    : failure.kind === "plan"
      ? run.plan.find((item) => item.key === failure.key)?.title
      : failure.kind === "artifact"
        ? run.artifacts.find((item) => item.id === failure.key)?.title
        : undefined;
  const key = failure.key.trim();
  const title = matchedTitle?.trim() || (key && key.length <= 40 && !/[._:/\\-]/.test(key) ? formatRunValue(key) : "");
  return title && !noticesOverlap(title, failure.reason) ? title : "";
}

function distinctGateFailures<T extends { kind: string; key: string; reason: string }>(failures: readonly T[]): T[] {
  const seen = new Set<string>();
  return failures.filter((failure) => {
    const key = normalizedNotice(failure.reason) || `${failure.kind}:${failure.key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ReviewPolicy({ profile }: { profile: "relaxed" | "strict" }) {
  return <div className="gate-standard-grid" aria-label="Completion review standards">
    {profile === "relaxed" ? <>
      <div className="task-row"><ShieldCheck size={ICON_SIZE.sm} /><span className="history-copy"><strong>Core outcome</strong><small>Required deliverables must be materially present</small></span></div>
      <div className="task-row"><ShieldCheck size={ICON_SIZE.sm} /><span className="history-copy"><strong>Relevance</strong><small>The result must directly address the task</small></span></div>
      <div className="task-row"><ShieldCheck size={ICON_SIZE.sm} /><span className="history-copy"><strong>Coherence</strong><small>No material contradiction or unresolved blocker</small></span></div>
      <div className="task-row"><ShieldCheck size={ICON_SIZE.sm} /><span className="history-copy"><strong>Uncertainty</strong><small>Secondary unknowns may remain explicit</small></span></div>
    </> : <>
      <div className="task-row"><ShieldCheck size={ICON_SIZE.sm} /><span className="history-copy"><strong>Progress</strong><small>No terminal failure loop</small></span></div>
      <div className="task-row"><ShieldCheck size={ICON_SIZE.sm} /><span className="history-copy"><strong>Evidence</strong><small>Required checks need independent, current evidence</small></span></div>
      <div className="task-row"><ShieldCheck size={ICON_SIZE.sm} /><span className="history-copy"><strong>Contract</strong><small>Each acceptance criterion must be covered</small></span></div>
      <div className="task-row"><ShieldCheck size={ICON_SIZE.sm} /><span className="history-copy"><strong>Claims</strong><small>Completion claims require a check, receipt, or artifact</small></span></div>
      <div className="task-row"><ShieldCheck size={ICON_SIZE.sm} /><span className="history-copy"><strong>Approval</strong><small>Approval boundaries cannot be auto-resumed</small></span></div>
      <div className="task-row"><ShieldCheck size={ICON_SIZE.sm} /><span className="history-copy"><strong>Delivery</strong><small>Final response must be substantive and non-empty</small></span></div>
    </>}
  </div>;
}

function GateEvaluationHistory({ gates, primaryFailureGateId, primaryFailureReasons }: {
  gates: TaskRun["supervision"]["latestGates"];
  primaryFailureGateId?: string;
  primaryFailureReasons: string[];
}) {
  return <div className="gate-evaluation-list">{gates.map((gate) => {
    const failures = distinctGateFailures(gate.failures);
    const status = gate.passed ? "passed" : failures.length ? "failed" : "deferred";
    const summary = gate.summary.trim();
    const normalizedSummary = normalizedNotice(summary);
    const gateLabel = normalizedNotice(formatRunValue(gate.gateType));
    const summaryRestatesVerdict = [
      `${gateLabel} passed`, `${gateLabel} is passed`,
      `${gateLabel} failed`, `${gateLabel} is failed`,
      `${gateLabel} blocked`, `${gateLabel} is blocked`,
      `${gateLabel} deferred`, `${gateLabel} is deferred`,
    ].includes(normalizedSummary);
    const summaryRepeatsDetail = [...failures.map((failure) => failure.reason), ...(gate.criterionCoverage ?? []).map((criterion) => criterion.reason)]
      .some((detail) => noticesOverlap(summary, detail));
    const statusLabel = gate.passed ? "Passed" : failures.length > 1 ? formatCount(failures.length, "failure") : failures.length ? "Failed" : "Deferred";
    return <details className="gate-evaluation" key={gate.id}>
      <summary><span className="meta-line" data-tone={operationalTone(status)}>{gate.passed ? <Check size={ICON_SIZE.sm} /> : failures.length ? <X size={ICON_SIZE.sm} /> : <Circle size={ICON_SIZE.sm} />}{formatRunValue(gate.gateType)}</span><small data-tone={operationalTone(status)}>{statusLabel}</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
      <div className="run-step-content">{summary && !summaryRestatesVerdict && !summaryRepeatsDetail && <p>{summary}</p>}{gate.criterionCoverage?.length ? <div className="criterion-list">{gate.criterionCoverage.map((criterion) => {
        const reasonRepeatsPrimaryFailure = gate.id === primaryFailureGateId
          && primaryFailureReasons.some((reason) => noticesOverlap(reason, criterion.reason));
        return <div className="criterion-row" data-tone={criterion.status === "covered" ? "success" : criterion.status === "blocked" ? "warning" : "danger"} key={criterion.criterion}><strong>{formatRunValue(criterion.status)}</strong><p>{criterion.criterion}</p>{criterion.reason && !reasonRepeatsPrimaryFailure && <small>{criterion.reason}</small>}</div>;
      })}</div> : null}{gate.id !== primaryFailureGateId && failures.map((failure) => <GateFailureRow failure={failure} label={failure.disposition} key={`${failure.kind}:${failure.key}`} />)}</div>
    </details>;
  })}</div>;
}

function reviewActionLabel(action: string): string {
  if (action === "complete_taskrun") return "Accepted";
  if (action === "start_continuation") return "Continuing automatically";
  if (action === "pause_for_approval") return "Approval required";
  if (action === "block_taskrun") return "Blocked";
  if (action === "steer") return "Course correction";
  return formatRunValue(action);
}

function reviewActionTone(action: string): OperationalTone | undefined {
  if (action === "complete_taskrun") return "success";
  if (action === "pause_for_approval") return "warning";
  if (action === "block_taskrun") return "danger";
  if (action === "start_continuation" || action === "steer") return "info";
  return undefined;
}

function RunReviewPanel({ run, outcomeExplanation = "", mode = "all" }: { run: TaskRun; outcomeExplanation?: string; mode?: "all" | "outcome" | "details" }) {
  const gateProfile = run.contract?.executionPolicy?.gateProfile ?? "strict";
  const decision = run.supervision.latestDecision;
  const gates = run.supervision.latestGates;
  const settledCompletion = gates.find((gate) => gate.gateType === "completion");
  const rawCompletionFailures = settledCompletion?.failures ?? run.completionGate.failures.map((failure) => ({ ...failure, disposition: "auto_fixable" as const }));
  const completionFailures = distinctGateFailures(rawCompletionFailures);
  const passedGates = gates.filter((gate) => gate.passed).length;
  const failedGateCount = gates.filter((gate) => !gate.passed && gate.failures.length > 0).length;
  const deferredGates = gates.length - passedGates - failedGateCount;
  const evaluationSummary = [
    passedGates > 0 ? `${passedGates} passed` : "",
    failedGateCount > 0 ? `${failedGateCount} failed` : "",
    deferredGates > 0 ? `${deferredGates} deferred` : "",
  ].filter(Boolean).join(" · ");
  const hasOutcome = completionFailures.length > 0 || Boolean(decision && (decision.action !== "complete_taskrun" || run.status !== "completed"));
  const hasDetails = Boolean(decision) || gates.length > 0;
  if (!hasOutcome && !hasDetails) return null;
  if (mode === "outcome" && !hasOutcome) return null;
  if (mode === "details" && !hasDetails) return null;
  const decisionEvaluator = decision
    ? decision.evaluator === "llm" ? `LLM · ${decision.evaluatorModel}` : "System invariant"
    : "";
  const decisionEvaluatorMeta = decision
    ? [`${Math.round(decision.confidence * 100)}% confidence`, decision.attempt > 1 ? `attempt ${decision.attempt}` : ""].filter(Boolean).join(" · ")
    : "";
  const detailsSummary = hasOutcome
    ? ""
    : gates.length > 1
      ? evaluationSummary
      : decision
        ? reviewActionLabel(decision.action)
        : gateProfile === "off" ? "Direct delivery" : "";
  const rationale = decision?.rationale.trim() ?? "";
  const explanation = outcomeExplanation.trim() || rationale;
  const repeatsFailureReason = explanation
    ? completionFailures.some((failure) => noticesOverlap(failure.reason, explanation))
    : false;
  const recordedRationale = outcomeExplanation && rationale && !noticesOverlap(outcomeExplanation, rationale)
    ? rationale
    : "";
  const outcomeLabel = decision ? reviewActionLabel(decision.action) : "Completion blocked";
  const outcomeRestatesStatus = normalizedNotice(outcomeLabel) === normalizedNotice(formatRunStatus(run.status))
    || (run.status === "blocked" && outcomeLabel === "Completion blocked");
  const showExplanation = Boolean(explanation && !repeatsFailureReason);
  const showOutcome = mode !== "details" && hasOutcome;
  const showDetails = mode !== "outcome" && hasDetails;
  return <section className="audit-section">
    {showOutcome && <>
      <div className="section-heading"><span>{outcomeRestatesStatus ? "Why it stopped" : "Review outcome"}</span>{completionFailures.length > 1 && <small data-tone="warning">{formatCount(completionFailures.length, "blocker")}</small>}</div>
      {(!outcomeRestatesStatus || showExplanation) && <div className="review-outcome">
        {!outcomeRestatesStatus && <div><Eye size={ICON_SIZE.md} /><strong data-tone={decision ? reviewActionTone(decision.action) : "warning"}>{outcomeLabel}</strong></div>}
        {showExplanation && <p>{explanation}</p>}
      </div>}
      {completionFailures.length > 0 && <div className="gate-failure-list">{completionFailures.map((failure) => <GateFailureRow failure={failure} label={completionFailures.length > 1 && !normalizedNotice(outcomeLabel).includes(normalizedNotice(failure.kind)) ? failure.kind : ""} title={completionFailures.length === 1 ? foregroundFailureTitle(run, failure) : undefined} key={`${failure.kind}:${failure.key}`} />)}</div>}
    </>}
    {showDetails && <details className="audit-disclosure">
      <summary><Eye size={ICON_SIZE.sm} /><span>Review details</span>{detailsSummary && <small>{detailsSummary}</small>}<ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
      <div>
        {recordedRationale && <div className="gate-detail"><span>Recorded rationale</span><p>{recordedRationale}</p></div>}
        {gates.length > 0 && <div className="run-evidence-group"><span className="run-evidence-group-label" data-label><span>Evaluation history</span>{gates.length > 1 && <small>{evaluationSummary}</small>}</span><GateEvaluationHistory gates={gates} primaryFailureGateId={completionFailures.length > 0 ? settledCompletion?.id : undefined} primaryFailureReasons={completionFailures.map((failure) => failure.reason)} /></div>}
        {gateProfile !== "off" && gates.length > 0 && <details className="detail-disclosure"><summary><span>Review policy</span><small>{gateProfile === "relaxed" ? "Relaxed · 4 rules" : "Strict · 6 rules"}</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary><ReviewPolicy profile={gateProfile} /></details>}
        {decision && <details className="detail-disclosure"><summary><span>Review provenance</span><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary><div className="audit-ledger"><div className="gate-detail"><span>Reason code</span><strong>{formatRunValue(decision.reasonCode)}</strong></div><div className="gate-detail"><span>Decision evaluator</span><strong>{decisionEvaluator}</strong>{decisionEvaluatorMeta && <small>{decisionEvaluatorMeta}</small>}</div></div></details>}
      </div>
    </details>}
  </section>;
}

function CurrentOperationPanel({ run }: { run: TaskRun }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (run.status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [run.id, run.status, run.updatedAt, run.checkpoint?.updatedAt]);
  if (run.status !== "running") return null;
  const operation = deriveCurrentOperation(run, now);
  if (operation.state === "running") return null;
  const operationLabel = operation.toolName || "Agent response";
  const idleFor = formatCompactDuration(now - operation.lastActivityAt);
  return <section className="audit-section">
    <div className="section-heading"><span>Current operation</span><small data-tone={operationalTone(operation.state)}>{formatRunValue(operation.state)} · {idleFor} idle</small></div>
    <div className="audit-ledger current-operation-ledger">
      <strong className="truncate" title={operationLabel}>{operationLabel}</strong>
    </div>
  </section>;
}

type ContextManifestItem = ContextManifest["items"][number];

function contextItemMetadata(item: ContextManifestItem): Record<string, unknown> {
  return item.metadata && typeof item.metadata === "object" ? item.metadata : {};
}

function contextSourceLabel(item: ContextManifestItem): string {
  const metadata = contextItemMetadata(item);
  if (item.kind === "system_prompt") return "Runtime instructions";
  if (item.kind === "taskrun_contract") return "Task contract";
  if (item.kind === "workspace_goal") return "Workspace goal";
  if (item.kind === "user_prompt") return "Current request";
  if (item.kind === "session_message" || item.kind === "transcript_message") return item.role ? `${formatRunValue(item.role)} message` : "Conversation message";
  if (item.kind === "core_memory") return "Core memory";
  if (item.kind === "memory_card") return "Recalled memory";
  if (item.kind === "cold_topic") return "Archived memory";
  if (item.kind === "skill") return typeof metadata.name === "string" && metadata.name.trim() ? `Skill · ${metadata.name.trim()}` : "Workspace skill";
  if (item.kind === "project_rule") {
    const path = typeof metadata.path === "string" ? metadata.path.trim() : "";
    return path ? `Project rule · ${path}` : "Project rule";
  }
  return formatRunValue(item.kind);
}

function contextSourceReason(reason: string): string {
  const normalized = normalizedNotice(reason);
  if (["current input", "current runtime instruction"].includes(normalized)) return "Current request";
  if (normalized === "required runtime instruction") return "Required for this run";
  if (normalized === "active taskrun execution contract") return "Defines the requested outcome";
  if (normalized === "immutable workspace goal direction") return "Provides workspace direction";
  if (normalized === "workspace referenced immutable skill revision") return "Referenced by this workspace";
  if (normalized === "selected by recent turn policy") return "Recent conversation";
  if (["outside recent turn policy", "dropped by turn limit or context window policy"].includes(normalized)) return "Outside the recent conversation window";
  if (normalized === "stable core memory injection") return "Stable workspace context";
  if (normalized.startsWith("selected by recall trace")) return "Relevant recalled memory";
  if (normalized === "selected by topic routing") return "Relevant archived context";
  return reason.trim();
}

function groupContextSources(items: ContextManifestItem[]) {
  const groups = new Map<string, { label: string; reason: string; count: number }>();
  for (const item of items) {
    const label = contextSourceLabel(item);
    const reason = contextSourceReason(item.reason);
    const key = `${normalizedNotice(label)}\u0000${normalizedNotice(reason)}`;
    const current = groups.get(key);
    if (current) current.count += 1;
    else groups.set(key, { label, reason: noticesOverlap(label, reason) ? "" : reason, count: 1 });
  }
  return [...groups.values()];
}

function ContextManifestPanel({ run }: { run: TaskRun }) {
  const [history, setHistory] = useState<{ runId: string; items: ContextManifest[] } | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [expandedRunId, setExpandedRunId] = useState("");
  const [requestError, setRequestError] = useState<{ runId: string; message: string } | null>(null);
  const expanded = expandedRunId === run.id;
  const manifests = history?.runId === run.id ? history.items : [];
  const error = requestError?.runId === run.id ? requestError.message : "";
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    void api.contextManifests(run.id).then((items) => { if (active) { setHistory({ runId: run.id, items }); setSelectedId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? ""); } }).catch((cause) => { if (active) setRequestError({ runId: run.id, message: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { active = false; };
  }, [expanded, run.id, run.supervision.latestContextManifest?.id]);
  const current = manifests.find((item) => item.id === selectedId) ?? run.supervision.latestContextManifest;
  if (!current) return null;
  const previous = manifests[manifests.findIndex((item) => item.id === current.id) + 1];
  const selected = current.items.filter((item) => item.selected);
  const omitted = current.items.filter((item) => !item.selected);
  const previousSelected = new Set(previous?.items.filter((item) => item.selected).map((item) => `${item.kind}:${item.sourceId}`) ?? []);
  const currentSelected = new Set(selected.map((item) => `${item.kind}:${item.sourceId}`));
  const added = previous ? selected.filter((item) => !previousSelected.has(`${item.kind}:${item.sourceId}`)) : [];
  const removed = previous?.items.filter((item) => item.selected && !currentSelected.has(`${item.kind}:${item.sourceId}`)) ?? [];
  const estimatedTokens = selected.reduce((sum, item) => sum + item.estimatedTokens, 0);
  const hasSelectionChanges = added.length > 0 || removed.length > 0;
  if (!current.items.length) return null;
  const selectedGroups = groupContextSources(selected);
  const omittedGroups = groupContextSources(omitted);
  const addedGroups = groupContextSources(added);
  const removedGroups = groupContextSources(removed);
  const selectionSummary = [`${current.items.length} total`, omitted.length > 0 ? `${omitted.length} omitted` : ""].filter(Boolean).join(" · ");
  const selectionDiff = [added.length > 0 ? `${added.length} added` : "", removed.length > 0 ? `${removed.length} removed` : ""].filter(Boolean).join(" · ");
  return <details className="audit-section audit-disclosure" open={expanded} onToggle={(event) => { setExpandedRunId(event.currentTarget.open ? run.id : ""); if (event.currentTarget.open) setRequestError(null); }}>
    <summary><FileText size={ICON_SIZE.sm} /><span>Context sources</span><small>{selectionSummary}</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
    <div className="context-manifest-card">
      {manifests.length > 1 && <div className="gate-detail"><label className="form-field"><span>Snapshot</span><select value={current.id} onChange={(event) => setSelectedId(event.target.value)}>{manifests.map((item) => <option value={item.id} key={item.id}>{[item.attempt > 1 ? `attempt ${item.attempt}` : "", formatRunValue(item.source), new Date(item.createdAt).toLocaleTimeString()].filter(Boolean).join(" · ")}</option>)}</select></label></div>}
      {selected.length > 0 && <details className="audit-disclosure"><summary><span>Used sources</span><small>{selected.length}</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary><div className="audit-ledger">{selectedGroups.map((group) => <div className="gate-detail" key={`${group.label}:${group.reason}`}><span>{group.label}{group.count > 1 ? ` · ${group.count}` : ""}</span>{group.reason && <small>{group.reason}</small>}</div>)}</div></details>}
      {omitted.length > 0 && <details className="audit-disclosure"><summary><span>Omitted sources</span><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary><div className="audit-ledger">{omittedGroups.map((group) => <div className="gate-detail" key={`${group.label}:${group.reason}`}><span>{group.label}{group.count > 1 ? ` · ${group.count}` : ""}</span>{group.reason && <small>{group.reason}</small>}</div>)}</div></details>}
      {hasSelectionChanges && <details className="audit-disclosure"><summary><span>Snapshot changes</span><small>{selectionDiff}</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary><div className="audit-ledger">{addedGroups.map((group) => <div className="gate-detail" key={`add:${group.label}:${group.reason}`}><span>Added · {group.label}{group.count > 1 ? ` · ${group.count}` : ""}</span></div>)}{removedGroups.map((group) => <div className="gate-detail" key={`remove:${group.label}:${group.reason}`}><span>Removed · {group.label}{group.count > 1 ? ` · ${group.count}` : ""}</span></div>)}</div></details>}
      <details className="audit-disclosure"><summary><span>Context provenance</span><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary><div className="audit-ledger"><div className="gate-detail">{estimatedTokens > 0 && <span>{formatCount(estimatedTokens, "estimated token")}</span>}<code>hash {current.manifestHash.slice(0, 12)}</code>{manifests.length > 1 && <small>{formatCount(manifests.length, "retained snapshot")}</small>}</div></div></details>
      {error && <small data-tone="danger">{error}</small>}
    </div>
  </details>;
}

function ArtifactsPanel({ run }: { run: TaskRun }) {
  const [selectedId, setSelectedId] = useState("");
  const [preview, setPreview] = useState<ArtifactContent | null>(null);
  const [loadingId, setLoadingId] = useState("");
  const [downloadingId, setDownloadingId] = useState("");
  const [error, setError] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const previewAuthorityRef = useRef(new LatestRequestAuthority());
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { previewAuthorityRef.current.invalidate(); setSelectedId(""); setPreview(null); setError(""); setLoadingId(""); setDownloadingId(""); setDownloadError(""); }, [run.id]);
  const openArtifact = async (artifact: Artifact) => {
    if (selectedId === artifact.id && preview) { previewAuthorityRef.current.invalidate(); setSelectedId(""); setPreview(null); setError(""); setLoadingId(""); return; }
    const requestToken = previewAuthorityRef.current.begin();
    setSelectedId(artifact.id); setPreview(null); setError(""); setLoadingId(artifact.id);
    try {
      const content = await api.artifactContent(run.id, artifact.id);
      if (previewAuthorityRef.current.isCurrent(requestToken)) setPreview(content);
    } catch (cause) {
      if (previewAuthorityRef.current.isCurrent(requestToken)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (previewAuthorityRef.current.isCurrent(requestToken)) setLoadingId("");
    }
  };
  const downloadArtifact = async (artifact: Artifact) => {
    setDownloadingId(artifact.id); setDownloadError("");
    try { await api.downloadArtifact(run.id, artifact.id, artifact.title); }
    catch (cause) { setDownloadError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setDownloadingId(""); }
  };
  const closePreview = () => { previewAuthorityRef.current.invalidate(); setSelectedId(""); setPreview(null); setError(""); setLoadingId(""); };
  useModalFocus(Boolean(selectedId), dialogRef, closePreview, closeRef);
  const selectedArtifact = run.artifacts.find((item) => item.id === selectedId);
  return <section className="audit-section">
    <div className="section-heading"><span>Artifacts</span><small>{run.artifacts.length}</small></div>
    <div className="artifact-list">{run.artifacts.map((artifact) => {
      const selected = selectedId === artifact.id;
      return <div className="artifact-row" key={artifact.id}><FileText size={ICON_SIZE.md} /><button className="artifact-open" type="button" onClick={() => void openArtifact(artifact)} aria-expanded={selected} aria-label={`Preview ${artifact.title}`}><strong className="truncate" title={artifact.title}>{artifact.title}</strong><small className="truncate">{artifact.kind || "artifact"}</small></button><button className="artifact-download" type="button" onClick={() => void downloadArtifact(artifact)} disabled={downloadingId === artifact.id} title={`Download ${artifact.title}`} aria-label={`Download ${artifact.title}`}><Download size={ICON_SIZE.sm} /></button></div>;
    })}</div>{downloadError && <small data-tone="danger">{downloadError}</small>}
    {selectedId && createPortal(<div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePreview(); }}>
      <section ref={dialogRef} className="modal artifact-modal" role="dialog" aria-modal="true" aria-labelledby="artifact-modal-title">
        <header><div className="modal-title-group"><span>Artifact preview</span><strong className="truncate" id="artifact-modal-title" title={selectedArtifact?.title ?? "Artifact"}>{selectedArtifact?.title ?? "Artifact"}</strong></div><span><button className="icon-button" type="button" disabled={!selectedArtifact || downloadingId === selectedId} onClick={() => { if (selectedArtifact) void downloadArtifact(selectedArtifact); }} aria-label="Download artifact"><Download size={ICON_SIZE.sm} /></button><button ref={closeRef} className="icon-button" type="button" onClick={closePreview} aria-label="Close artifact preview"><X size={ICON_SIZE.md} /></button></span></header>
        <div className="artifact-modal-body">{loadingId === selectedId ? <div className="artifact-preview-state"><Activity className="spin" size={ICON_SIZE.md} />Loading preview…</div>
          : error ? <div className="artifact-preview-state" data-tone="danger">{error}<small>Unsupported or unavailable artifacts can still be downloaded.</small></div>
          : preview ? <><div className="artifact-preview-meta"><span>{preview.format} · {formatCount(preview.bytes, "byte")}</span><small>{preview.source === "file" ? "loaded from workspace file" : "stored content"}</small></div>{preview.format === "markdown" ? <Markdown>{preview.content}</Markdown> : <pre className="artifact-text-preview">{preview.content}</pre>}</>
          : null}</div>
      </section>
    </div>, document.body)}
  </section>;
}

function RunEvidencePanel({ run }: { run: TaskRun }) {
  const hasPlan = run.plan.length > 0;
  const hasChecks = run.checks.length > 0;
  const hasContinuations = run.continuations.length > 0;
  const groupCount = Number(hasPlan) + Number(hasChecks) + Number(hasContinuations);
  if (groupCount === 0) return null;

  const planDone = run.plan.filter((item) => item.status === "done").length;
  const checksPassed = run.checks.filter((item) => item.status === "passed" && !item.stale).length;
  const failedItems = run.plan.filter((item) => item.status === "blocked").length
    + run.checks.filter((item) => item.stale || ["failed", "blocked"].includes(item.status)).length
    + run.continuations.filter((item) => ["blocked", "failed", "cancelled"].includes(item.status)).length;
  const openItems = run.plan.filter((item) => ["pending", "in_progress"].includes(item.status)).length
    + run.checks.filter((item) => ["pending", "running"].includes(item.status)).length
    + run.continuations.filter((item) => ["queued", "running"].includes(item.status)).length;
  const title = groupCount > 1
    ? "Execution evidence"
    : hasPlan
      ? "Plan"
      : hasChecks
        ? "Checks"
        : "Continuations";
  const summary = failedItems > 0
    ? failedItems === 1 ? "Needs attention" : `${failedItems} need attention`
    : openItems > 0
      ? `${openItems} open`
      : "Complete";

  return <details className="audit-section audit-disclosure">
    <summary><ShieldCheck size={ICON_SIZE.sm} /><span>{title}</span><small data-tone={failedItems > 0 ? "danger" : openItems > 0 ? "info" : "success"}>{summary}</small><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
    <div className="run-evidence-ledger">
      {hasPlan && <div className="run-evidence-group">
        {groupCount > 1 && <span className="run-evidence-group-label" data-label><span>Plan</span><small>{planDone}/{run.plan.length}</small></span>}
        <div className="task-list">{run.plan.map((item) => <div className="task-row" data-status={item.status} aria-label={`${item.title}: ${formatRunValue(item.status)}`} key={item.key}>{item.status === "done" ? <Check size={ICON_SIZE.md} /> : <Circle size={ICON_SIZE.sm} />}<span>{item.title}</span>{item.status !== "done" && <small data-tone={operationalTone(item.status)}>{formatRunValue(item.status)}</small>}</div>)}</div>
      </div>}
      {hasChecks && <div className="run-evidence-group">
        {groupCount > 1 && <span className="run-evidence-group-label" data-label><span>Checks</span><small>{checksPassed}/{run.checks.length}</small></span>}
        <div className="task-list">{run.checks.map((check) => { const status = check.stale ? "stale" : check.status; const passed = status === "passed"; return <div className="task-row" data-status={status} aria-label={`${check.title}: ${formatRunValue(status)}`} key={check.key}>{passed ? <Check size={ICON_SIZE.md} /> : <Circle size={ICON_SIZE.sm} />}<span>{check.title}</span>{!passed && <small data-tone={operationalTone(status)}>{formatRunValue(status)}</small>}</div>; })}</div>
      </div>}
      {hasContinuations && <div className="run-evidence-group">
        {groupCount > 1 && <span className="run-evidence-group-label" data-label><span>Continuations</span><small>{run.continuations.length}</small></span>}
        <div className="continuation-list">{run.continuations.map((item) => <div className="continuation-row" aria-label={`${item.reason}: ${formatRunValue(item.status)}`} key={item.id}><div><strong aria-hidden>{run.continuations.length > 1 ? `#${item.ordinal}` : ""}</strong><span>{item.reason}</span></div>{item.status !== "completed" && <small data-tone={runStatusTone(item.status)}>{formatRunValue(item.status)}</small>}</div>)}</div>
      </div>}
    </div>
  </details>;
}

function formatContractDecisionReason(value: string): string {
  return value.replace(/\b(\d+) semantic objective\(s\)/g, (_, count: string) => `${count} semantic objective${count === "1" ? "" : "s"}`);
}

function TaskContractPanel({ contract, runGoal }: { contract: NonNullable<TaskRun["contract"]>; runGoal: string }) {
  const identityValues = [runGoal, contract.summary, contract.sourceInput].map(normalizedNotice).filter(Boolean);
  const repeatedCriterionPrefixes = ["交付目标结果", "目标结果", "deliver target outcome", "deliver requested outcome"];
  const seenCriteria = new Set<string>();
  const criteria = contract.acceptanceCriteria.map((item) => item.trim()).filter((item) => {
    const normalized = normalizedNotice(item);
    if (!normalized || seenCriteria.has(normalized)) return false;
    seenCriteria.add(normalized);
    return !identityValues.some((identity) => normalized === identity
      || repeatedCriterionPrefixes.some((prefix) => normalized === `${prefix} ${identity}`));
  });
  const criteriaSummary = criteria.length > 0
    ? formatCount(criteria.length, "criterion", "criteria")
    : "";
  const scope = contract.scope.trim();
  const scopeIsDistinct = Boolean(scope)
    && normalizedNotice(scope) !== normalizedNotice(runGoal)
    && normalizedNotice(scope) !== normalizedNotice(contract.summary);
  const seenNonGoals = new Set<string>();
  const nonGoals = contract.nonGoals.map((item) => item.trim()).filter((item) => {
    const normalized = normalizedNotice(item);
    if (!normalized || seenNonGoals.has(normalized)) return false;
    seenNonGoals.add(normalized);
    return true;
  });
  return <details className="run-contract">
    <summary><span>Task contract</span>{criteriaSummary && <small>{criteriaSummary}</small>}<ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
    <div>
      {criteria.length > 0 && <div><span data-label>Acceptance criteria</span><ul>{criteria.map((criterion) => <li key={normalizedNotice(criterion)}>{criterion}</li>)}</ul></div>}
      {scopeIsDistinct && <div><span data-label>Included</span><p>{scope}</p></div>}
      {nonGoals.length > 0 && <div><span data-label>Not included</span><ul>{nonGoals.map((item) => <li key={normalizedNotice(item)}>{item}</li>)}</ul></div>}
      <details className="detail-disclosure">
        <summary><span>Routing details</span><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
        <div className="audit-ledger">
          <div className="gate-detail"><span>Classification</span><small>{formatRunValue(contract.intent)} · {formatRunValue(contract.relation)}</small></div>
          {contract.decisionReason && <div className="gate-detail"><span>Decision reason</span><p>{formatContractDecisionReason(contract.decisionReason)}</p></div>}
        </div>
      </details>
    </div>
  </details>;
}

function RunStatusNotice({ notice }: { notice: NonNullable<ReturnType<typeof runStatusNotice>> }) {
  const compact = notice.text.length > 240 || notice.text.includes(";");
  if (!compact) return <div className="run-status-note" data-tone={notice.tone}>{notice.text}</div>;
  const firstClause = notice.text.split(";", 1)[0]?.trim() ?? notice.text;
  const machinePrefixed = /^[a-z0-9_]+:\s*/i.test(firstClause);
  const readableClause = firstClause.replace(/^[a-z0-9_]+:\s*/i, "");
  const summary = machinePrefixed ? readableClause.split(": ", 1)[0]?.trim() || readableClause : readableClause;
  return <details className="run-status-note" data-tone={notice.tone}>
    <summary><span>{summary}</span><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary>
    <p>{notice.text}</p>
  </details>;
}

function normalizedNotice(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function noticesOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizedNotice(left);
  const normalizedRight = normalizedNotice(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  const [shorter, longer] = normalizedLeft.length < normalizedRight.length
    ? [normalizedLeft, normalizedRight]
    : [normalizedRight, normalizedLeft];
  return shorter.length >= 24 && longer.includes(shorter);
}

export function RunDetails({ run, showIdentity = true }: { run: TaskRun; showIdentity?: boolean }) {
  const checkpoint = run.checkpoint && !run.checkpoint.active && (run.checkpoint.currentTool || run.checkpoint.assistantPartial.trim())
    ? run.checkpoint
    : null;
  const statusLabel = formatRunStatus(run.status);
  const phaseLabel = formatRunValue(run.phase);
  const showPhase = !isRedundantRunPhase(run.status, run.phase);
  const rawStatusNotice = runStatusNotice(run.status, run.blockedReason);
  const settledCompletion = run.supervision.latestGates.find((gate) => gate.gateType === "completion");
  const completionFailures = settledCompletion?.failures ?? run.completionGate.failures;
  const decision = run.supervision.latestDecision;
  const reviewCopy = [run.supervision.latestDecision?.rationale, ...(settledCompletion?.failures ?? run.completionGate.failures).map((failure) => failure.reason)]
    .filter((value): value is string => Boolean(value));
  const statusNotice = rawStatusNotice && !reviewCopy.some((value) => noticesOverlap(value, rawStatusNotice.text)) ? rawStatusNotice : null;
  const reviewHasOutcome = completionFailures.length > 0 || Boolean(decision && (decision.action !== "complete_taskrun" || run.status !== "completed"));
  const primaryInteractionOwnsOutcome = Boolean(run.pendingUserInput || run.supervision.approvalRequests.some((approval) => approval.status === "pending"));
  const showReviewOutcome = reviewHasOutcome && !primaryInteractionOwnsOutcome;
  const reviewOwnsStatusNotice = Boolean(statusNotice && showReviewOutcome && statusNotice.text.length <= 240 && !statusNotice.text.includes(";"));
  const visibleStatusNotice = primaryInteractionOwnsOutcome || reviewOwnsStatusNotice ? null : statusNotice;
  const reviewOutcomeExplanation = reviewOwnsStatusNotice ? statusNotice?.text : "";
  return <div className="run-details">
    {showIdentity && <section className="run-summary"><div className="phase-line meta-line"><span className="status-label" data-tone={runStatusTone(run.status)}><span className="status-dot" />{statusLabel}</span>{showPhase && <span>{phaseLabel}</span>}{run.attempt > 1 && <span>attempt {run.attempt}</span>}</div><p><strong>{run.goal}</strong></p>{visibleStatusNotice && <RunStatusNotice notice={visibleStatusNotice} />}</section>}
    {!showIdentity && visibleStatusNotice && <section className="run-summary"><RunStatusNotice notice={visibleStatusNotice} /></section>}
    <CurrentOperationPanel run={run} />
    {showReviewOutcome && <RunReviewPanel run={run} outcomeExplanation={reviewOutcomeExplanation} mode="outcome" />}
    {run.artifacts.length > 0 && <ArtifactsPanel run={run} />}
    {checkpoint && <details className="audit-section audit-disclosure"><summary><FileText size={ICON_SIZE.sm} /><span>Preserved work</span><ChevronRight className="tool-chevron" size={ICON_SIZE.sm} /></summary><div className="audit-ledger">{checkpoint.currentTool && <div className="gate-detail"><span>Last tool</span><strong className="truncate" title={checkpoint.currentTool.toolName}>{checkpoint.currentTool.toolName}</strong></div>}{checkpoint.assistantPartial.trim() && <div className="gate-detail"><span>Partial response</span><p>{checkpoint.assistantPartial}</p></div>}</div></details>}
    {run.contract && <section className="audit-section"><TaskContractPanel contract={run.contract} runGoal={run.goal} /></section>}
    {reviewHasOutcome ? <RunReviewPanel run={run} outcomeExplanation={reviewOutcomeExplanation} mode="details" /> : <RunReviewPanel run={run} />}
    <RunEvidencePanel run={run} />
    <ContextManifestPanel run={run} />
  </div>;
}

export type RunApproval = TaskRun["supervision"]["approvalRequests"][number];

function approvalTypeLabel(actionType: RunApproval["actionType"]): string {
  if (actionType === "execute_external_action") return "External action";
  if (actionType === "start_parallel_taskrun") return "Parallel TaskRun";
  return "Resume TaskRun";
}

function approvalActionLabel(actionType: RunApproval["actionType"]): string {
  if (actionType === "execute_external_action") return "Approve & execute";
  if (actionType === "start_parallel_taskrun") return "Approve & start";
  return "Approve & resume";
}

export function ApprovalDock({ run, approvals, resolvingId, resolvingDecision, onResolve }: {
  run: TaskRun;
  approvals: RunApproval[];
  resolvingId: string;
  resolvingDecision: "approved" | "rejected" | "";
  onResolve: (approval: RunApproval, decision: "approved" | "rejected") => Promise<void>;
}) {
  return <section className="approval-dock" aria-label="Pending approvals" aria-live="polite">
    <header className="section-heading approval-dock-heading"><span><ShieldAlert size={ICON_SIZE.sm} />Approval required</span>{approvals.length > 1 && <small>{formatCount(approvals.length, "action")}</small>}</header>
    {approvals.map((approval) => {
      const approvedAttempt = approval.metadata.approvedAttempt;
      const attempt = typeof approvedAttempt === "number" ? approvedAttempt : run.attempt;
      const context = [approvalTypeLabel(approval.actionType), attempt > 1 ? `Attempt ${attempt}` : ""].filter(Boolean).join(" · ");
      const busy = resolvingId === approval.id;
      return <article className="approval-card" key={approval.id}>
        <span className="approval-card-icon" aria-hidden="true"><ShieldAlert size={ICON_SIZE.lg} /></span>
        <div className="approval-card-copy">
          <small>{context}</small>
          <strong>{approval.reason}</strong>
          {approval.actionType === "execute_external_action" && <small>Authorization is limited to Attempt {attempt}; any later Attempt requires a new approval.</small>}
        </div>
        <div className="approval-card-actions">
          <button className="control" data-variant="primary" type="button" disabled={Boolean(resolvingId)} onClick={() => void onResolve(approval, "approved")}>{busy && resolvingDecision === "approved" ? <Activity className="spin" size={ICON_SIZE.md} /> : <ShieldCheck size={ICON_SIZE.md} />}{busy && resolvingDecision === "approved" ? "Approving…" : approvalActionLabel(approval.actionType)}</button>
          <button className="control" data-tone="danger" type="button" disabled={Boolean(resolvingId)} onClick={() => void onResolve(approval, "rejected")}>{busy && resolvingDecision === "rejected" && <Activity className="spin" size={ICON_SIZE.md} />}{busy && resolvingDecision === "rejected" ? "Rejecting…" : "Reject"}</button>
        </div>
      </article>;
    })}
  </section>;
}

export interface QueuePromptProps {
  item: SessionInboxItem; index: number; editing: boolean; draft: string; busy: boolean; starting: boolean; canMoveUp: boolean; canMoveDown: boolean;
  onEdit: () => void; onDraftChange: (value: string) => void; onSave: () => void; onCancelEdit: () => void; onStart: () => void; onToggleDefer: () => void; onMergeFirst: () => void; onDelete: () => void; onMoveUp: () => void; onMoveDown: () => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void; onDragEnd: () => void; onDrop: (event: DragEvent<HTMLElement>) => void;
}

export function QueuePrompt({ item, index, editing, draft, busy, starting, canMoveUp, canMoveDown, onEdit, onDraftChange, onSave, onCancelEdit, onStart, onToggleDefer, onMergeFirst, onDelete, onMoveUp, onMoveDown, onDragStart, onDragEnd, onDrop }: QueuePromptProps) {
  const summary = item.analysis.summary.trim();
  const originalRequest = item.content.trim();
  const requestSummary = summary || originalRequest;
  const hasDistinctOriginal = Boolean(summary && originalRequest && summary !== originalRequest);
  return <article className="inbox-item" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={onDrop}>
    <button draggable={!busy && !editing} onDragStart={onDragStart} onDragEnd={onDragEnd} disabled={busy || editing} aria-label={`Drag prompt ${index + 1} to reorder`} title="Drag to reorder"><GripVertical size={ICON_SIZE.sm} /></button>
    <span className="inbox-position">{index + 1}</span>
    <div>{editing ? <textarea className="queue-editor" value={draft} onChange={(event) => onDraftChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") onCancelEdit(); if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) onSave(); }} autoFocus rows={2} aria-label="Edit queued prompt" /> : <><strong>{requestSummary}</strong>{item.decision === "defer" && <span className="intent-badge">Deferred</span>}<details className="queue-details"><summary><span>Task details</span><ChevronRight className="tool-chevron" size={ICON_SIZE.xs} /></summary><div>{hasDistinctOriginal && <div><span data-label>Original request</span><p>{item.content}</p></div>}<div className="inbox-routing"><span className="intent-badge">{formatRunValue(item.analysis.intent)}</span><span>{formatRunValue(item.analysis.relation)}</span><span>{formatRunValue(item.analysis.urgency)} · priority {item.analysis.priority}</span><span>{Math.round(item.analysis.confidence * 100)}% confidence</span>{item.analysis.targetRunId && <span>run {item.analysis.targetRunId.slice(0, 8)}</span>}</div>{item.analysis.reason && <p>{item.analysis.reason}</p>}{item.analysis.acceptanceCriteria.length > 0 && <div><strong>Acceptance criteria</strong><ul>{item.analysis.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul></div>}</div></details></>}
      <div className="inbox-actions">{editing ? <><button onClick={onSave} disabled={busy || !draft.trim()}>Save</button><button onClick={onCancelEdit} disabled={busy}>Cancel</button></> : <><button data-tone="accent" onClick={onStart} disabled={busy}>{starting ? "Starting…" : "Run now"}</button><details><summary>More <ChevronDown size={ICON_SIZE.xs} /></summary><div><button onClick={onEdit} disabled={busy}><Pencil size={ICON_SIZE.xs} /> Edit</button><button onClick={onToggleDefer} disabled={busy}>{item.decision === "defer" ? "Resume" : "Defer"}</button>{index > 0 && <button onClick={onMergeFirst} disabled={busy}>Merge first</button>}<button onClick={onMoveUp} disabled={busy || !canMoveUp} aria-label={`Move queued prompt ${index + 1} up`}>Move up</button><button onClick={onMoveDown} disabled={busy || !canMoveDown} aria-label={`Move queued prompt ${index + 1} down`}>Move down</button></div></details></>}</div>
    </div>
    <button onClick={onDelete} disabled={busy} aria-label="Remove queued input"><X size={ICON_SIZE.sm} /></button>
  </article>;
}
