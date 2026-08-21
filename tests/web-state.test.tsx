import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type CaptureJob, type Message, type RecallResult, type RuntimeStatus, type Session, type SessionInboxItem, type TaskRun, type TranscriptItem, type WarmMemory, type WorkspaceGoal, type WorkspaceGoalDefinition } from "../apps/web-console/src/api.js";
import { approvalResolutionNotice } from "../apps/web-console/src/approval-display.js";
import {
  ApprovalDock,
  ConversationDateDivider,
  ExecutionTimeline,
  QueuePrompt,
  RunDetails,
  TAgentMark,
  UserInputCard,
  WorkspaceRunStatus,
  type RunApproval,
} from "../apps/web-console/src/AppPanels.js";
import { ReviewProfileControl } from "../apps/web-console/src/App.js";
import { ConversationMessage, PendingConversationMessage } from "../apps/web-console/src/ConversationMessage.js";
import { GoalView } from "../apps/web-console/src/GoalsPanel.js";
import { goalStatusTone } from "../apps/web-console/src/goal-display.js";
import { MemoryCatalog, MemoryCoreProjection, MemoryJobLists, MemoryRecallResults } from "../apps/web-console/src/MemoryBrowser.js";
import { RecordDetail, TopicDetail } from "../apps/web-console/src/MemoryDetails.js";
import { MemoryPanel, MemoryUndoNotice } from "../apps/web-console/src/MemoryPanel.js";
import { WorkspaceSkillsControl } from "../apps/web-console/src/WorkspaceSkillsControl.js";
import { nextConversationPinState } from "../apps/web-console/src/conversation-scroll.js";
import { deriveCurrentOperation } from "../apps/web-console/src/current-operation.js";
import { createEventAcknowledger } from "../apps/web-console/src/event-acknowledger.js";
import { IntentPrefetchCache } from "../apps/web-console/src/intent-prefetch-cache.js";
import { MEMORY_PAGE_REQUEST_LIMIT, memoryPageWindow, mergeMemoryPage } from "../apps/web-console/src/memory-pagination.js";
import { canResumeRun, findActiveRun, formatRunStatus, formatRunValue, isActiveRunStatus, isRedundantRunPhase, runStatusNotice, runStatusTone } from "../apps/web-console/src/run-state.js";
import { runViewForResolvedRuns, runViewForResumedRun, runViewForStartedRun, runViewFromWorkspaceSnapshot } from "../apps/web-console/src/use-run-view-state.js";
import { mergeRefreshedMessages, shouldStreamWorkspaceRun, terminalStreamingAfterRefresh } from "../apps/web-console/src/use-workspace-live-sync.js";
import { groupExecutionItems, mergeTranscriptItems } from "../apps/web-console/src/transcript-projection.js";
import { createStreamingDeltaBatcher, type FrameScheduler } from "../apps/web-console/src/streaming-delta-batcher.js";
import { loadWorkspaceSnapshot } from "../apps/web-console/src/workspace-controller.js";
import { WorkspaceLiveSyncCoordinator, WorkspaceReconnectBackoff } from "../apps/web-console/src/workspace-live-sync.js";
import { LatestRequestAuthority } from "../apps/web-console/src/latest-request.js";
import { userInputRequestKey, userInputValuesForRequest } from "../apps/web-console/src/user-input-state.js";
import { WorkspaceSkillAuthority } from "../apps/web-console/src/workspace-skill-authority.js";
import { deriveWorkspaceNavigation, workspaceEmptyState } from "../apps/web-console/src/workspace-navigation.js";
import { mergeWorkspaceActivityBaseline } from "../apps/web-console/src/use-workspace-presentation.js";
import { ConversationHistoryAuthority, mergeEarlierMessages, messagePageHasOlderHint } from "../apps/web-console/src/use-conversation-history.js";
import { indexMemoryJobsByMessage } from "../apps/web-console/src/use-memory-annotations.js";
import { clampComposerHeight, nextComposerHistoryView, type ComposerHistoryView } from "../apps/web-console/src/use-workspace-composer.js";
import { replaceWorkspace, workspaceCreateGuardDelay, WorkspaceAuthority, WorkspaceCreationGuard } from "../apps/web-console/src/use-workspace-sessions.js";
import { hasPersistedSubmission } from "../apps/web-console/src/use-workspace-submission.js";
import { storedGateProfiles, storedStringLists, storedStringRecord } from "../apps/web-console/src/workspace-preferences.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: "run-1",
    sessionId: "session-1",
    status: "running",
    phase: "implement",
    goal: "Ship the result",
    modelId: "gpt-5.6-sol",
    reasoningEffort: "high",
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    lastEventSeq: 0,
    transcriptCount: 0,
    resumable: false,
    launchRetryable: false,
    blockedReason: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    plan: [],
    checks: [],
    artifacts: [],
    continuations: [],
    checkpoint: null,
    contract: null,
    pendingUserInput: null,
    completionGate: { passed: false, failures: [] },
    supervision: {
      progress: null,
      latestDecision: null,
      latestGates: [],
      latestContextManifest: null,
      approvalRequests: [],
    },
    ...overrides,
  } as TaskRun;
}

describe("Web workbench behavior", () => {
  it("keeps the completion Review policy visible in the composer control", () => {
    const markup = renderToStaticMarkup(<ReviewProfileControl value="relaxed" onChange={() => undefined} />);
    expect(markup).toContain('class="control"');
    expect(markup).toContain('aria-label="Review policy"');
    expect(markup).toContain('value="relaxed" selected="">Review · Relaxed');
  });

  it("rejects obsolete Workspace generations after returning to the same Workspace", () => {
    const authority = new WorkspaceAuthority();
    const firstA = authority.enter("workspace-a");
    authority.enter("workspace-b");
    const currentA = authority.enter("workspace-a");

    expect(authority.isCurrent(firstA)).toBe(false);
    expect(authority.isCurrent(currentA)).toBe(true);
    expect(authority.capture("workspace-b")).toBeNull();
  });

  it("replaces Workspace directory entries without disturbing their order", () => {
    const session = (id: string, title: string): Session => ({
      id,
      title,
      modelId: "gpt-5.6-sol",
      reasoningEffort: "medium",
      latestRunStatus: null,
      latestRunPhase: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const updated = session("workspace-b", "Updated B");
    const result = replaceWorkspace([
      session("workspace-a", "Workspace A"),
      session("workspace-b", "Workspace B"),
    ], updated);

    expect(result.map((item) => item.id)).toEqual(["workspace-a", "workspace-b"]);
    expect(result[1]).toBe(updated);
  });

  it("keeps Workspace creation locked through the double-click guard window", () => {
    const guard = new WorkspaceCreationGuard();

    expect(guard.tryEnter()).toBe(true);
    expect(guard.tryEnter()).toBe(false);
    expect(workspaceCreateGuardDelay(1_000, 1_125)).toBe(375);
    expect(workspaceCreateGuardDelay(1_000, 1_600)).toBe(0);
    guard.release();
    expect(guard.tryEnter()).toBe(true);
  });

  it("matches optimistic submissions only to equivalent persisted user messages", () => {
    const submission = { workspaceId: "workspace-1", content: "Ship the result", createdAt: 10_000 };
    const message = (overrides: Partial<Message> = {}): Message => ({
      id: 1,
      sessionId: "session-1",
      role: "user",
      content: "Ship the result",
      createdAt: 10_000,
      ...overrides,
    });

    expect(hasPersistedSubmission([message()], submission)).toBe(true);
    expect(hasPersistedSubmission([message({ createdAt: 5_000 })], submission)).toBe(true);
    expect(hasPersistedSubmission([message({ createdAt: 4_999 })], submission)).toBe(false);
    expect(hasPersistedSubmission([message({ role: "assistant" })], submission)).toBe(false);
    expect(hasPersistedSubmission([message({ content: "A different result" })], submission)).toBe(false);
  });

  it("uses the upload target as the empty Skills center state", () => {
    const markup = renderToStaticMarkup(<WorkspaceSkillsControl
      workspaceId="workspace-1"
      open
      onOpenChange={() => undefined}
      onBeforeOpen={() => undefined}
      onError={() => undefined}
      onNotice={() => undefined}
    />);

    expect(markup).toContain("Upload or drop a Skill");
    expect(markup).toContain("TaskRuns freeze referenced revisions");
    expect(markup).not.toContain("No Skills in the center");
    expect(markup).not.toContain("Shared Skills");
  });

  it("keeps Memory diagnostics free of empty counters and mechanical plurals", () => {
    const emptyRecall = {
      cards: [],
      coldTopics: [],
      trace: {
        topicIds: [],
        candidateCount: 0,
        deniedCount: 0,
      },
    } satisfies RecallResult;
    const recallProps = {
      query: "release policy",
      onClear: () => undefined,
      onOpenRecord: () => undefined,
      onSelectTopic: () => undefined,
    };
    const empty = renderToStaticMarkup(<MemoryRecallResults results={emptyRecall} {...recallProps} />);
    const traced = renderToStaticMarkup(<MemoryRecallResults results={{
      ...emptyRecall,
      trace: { ...emptyRecall.trace, candidateCount: 1, deniedCount: 1, topicIds: ["release"] },
    }} {...recallProps} />);
    const diagnostic = renderToStaticMarkup(<MemoryRecallResults results={{
      ...emptyRecall,
      trace: {
        ...emptyRecall.trace,
        version: 2,
        candidateCount: 1,
        embedding: { configured: true, degraded: false, generation: "embed-v2" },
        policyTransforms: 1,
        coldTopicRoutes: [{ topicId: "release", channels: ["topic"], selected: true, reason: "matched route" }],
        candidates: [{ id: "memory-1", channels: ["lexical"], rawScores: { lexical: 0.8 }, finalScore: 0.7, outcome: "selected" }],
      },
    }} {...recallProps} />);
    const captureJob = {
      id: "capture-1",
      request: {
        sourceRefs: [],
      },
      status: "completed_empty",
      attempts: 1,
      proposalCount: 0,
      persistedCount: 0,
      createdAt: 1,
      updatedAt: 1,
    } satisfies CaptureJob;
    const jobProps = { busy: false, onReindex: () => undefined };
    const jobs = renderToStaticMarkup(<MemoryJobLists reindexJobs={[]} jobs={[captureJob]} {...jobProps} />);

    expect(empty).toContain("No recall matches");
    expect(empty).not.toContain("0 candidates");
    expect(empty).not.toContain("0 cold routes");
    expect(empty).not.toContain("0 denied");
    expect(traced).toContain("1 candidate · 1 cold route · 1 denied");
    expect(traced).not.toContain("route(s)");
    expect(diagnostic).toContain("Recall diagnostics");
    expect(diagnostic).toContain("Candidate outcomes");
    expect(diagnostic).toContain("embed-v2");
    expect(jobs).toContain("1 job");
    expect(jobs).toContain("1 attempt");
    expect(jobs).not.toContain("1 jobs");
    expect(jobs).not.toContain("attempt(s)");
    expect(jobs).not.toContain("0 proposed");
    expect(jobs).not.toContain("0 persisted");
    const maintenance = renderToStaticMarkup(<MemoryJobLists reindexJobs={[]} jobs={[]} {...jobProps} />);
    expect(maintenance).toContain("Memory operations");
    expect(maintenance).toContain("Reindex durable memory");
    expect(maintenance).not.toContain("Recent capture");
    expect(maintenance).not.toContain("Durable index</span>");
  });

  it("keeps an ungenerated Core Memory snapshot compact and actionable", () => {
    const handlers = {
      coreText: "",
      onCoreTextChange: () => undefined,
      onGenerate: () => undefined,
      onSave: () => undefined,
    };
    const empty = renderToStaticMarkup(<MemoryCoreProjection core={null} {...handlers} />);
    const generated = renderToStaticMarkup(<MemoryCoreProjection core={{
      revision: 2,
      markdown: "# Core Memory\n",
      sourceRecordIds: [],
      tokenCount: 2,
      generatedAt: 1,
    }} {...handlers} coreText="# Core Memory\n" />);

    expect(empty).toContain("Generate snapshot");
    expect(empty).not.toContain("not generated");
    expect(empty).not.toContain("textarea");
    expect(empty).not.toContain("Save projection");
    expect(generated).toContain("revision 2 · 2 tokens");
    expect(generated).toContain("<details");
    expect(generated).toContain("textarea");
    expect(generated).toContain("Regenerate");
    expect(generated).toContain("Save projection");
  });

  it("keeps a forgotten Memory recoverable from the immediate result", () => {
    const undo = renderToStaticMarkup(<MemoryUndoNotice
      item={{ ids: ["memory-1"], topicIds: [], label: "Release policy", purgeAfter: Date.UTC(2026, 7, 30, 12) }}
      busy={false}
      onUndo={() => undefined}
    />);

    expect(undo).toContain("Forgot “Release policy”");
    expect(undo).toContain("Restorable until");
    expect(undo).toContain(">Undo</button>");
  });

  it("omits empty Memory catalog sections and their companion placeholders", () => {
    const props = {
      selectedRecordId: "",
      selectedTopicId: "",
      onOpenRecord: () => undefined,
      onOpenTopic: () => undefined,
      hasMoreRecords: false,
      loadingMoreRecords: false,
      onLoadMoreRecords: () => undefined,
      hasMoreTopics: false,
      loadingMoreTopics: false,
      onLoadMoreTopics: () => undefined,
    };
    const record: WarmMemory = {
      id: "memory-1",
      kind: "fact",
      tier: "warm",
      scope: { type: "workspace", id: "default" },
      title: "Release policy",
      content: "Use the current release contract.",
      summary: "Use the current release contract.",
      topicIds: [],
      entityIds: [],
      status: "active",
      confidence: 0.9,
      importance: 0.8,
      sourceRefs: [],
      createdAt: 1,
      updatedAt: 2,
    };
    const empty = renderToStaticMarkup(<MemoryCatalog records={[]} topics={[]} {...props} />);
    const recordsOnly = renderToStaticMarkup(<MemoryCatalog records={[record]} topics={[]} {...props} />);
    const repeatedTopic = "Use the current release contract.";
    const topicsOnly = renderToStaticMarkup(<MemoryCatalog records={[]} topics={[{
      topicId: "release", scope: record.scope, kind: "fact", title: `Fact: ${repeatedTopic}`, description: repeatedTopic,
      aliases: [], entityIds: [], relatedTopicIds: [], status: "active", createdAt: 1, updatedAt: 2,
    }]} {...props} />);
    const topicDetail = renderToStaticMarkup(<TopicDetail topic={{
      descriptor: {
        topicId: "release", scope: record.scope, kind: "fact", title: `Fact: ${repeatedTopic}`, description: repeatedTopic,
        aliases: [], entityIds: [], relatedTopicIds: [], status: "active", createdAt: 1, updatedAt: 2,
      },
      revision: { id: "revision-1", revision: 1, checksum: "abc", tokenCount: 4, createdAt: 1 },
      body: "Canonical release contract.",
    }} onForget={() => undefined} onRestore={() => undefined} />);

    expect(empty).toBe("");
    expect(recordsOnly).toContain("Memory cards");
    expect(recordsOnly).not.toContain("Canonical topic pages");
    expect(recordsOnly).not.toContain("No matching Cold topics");
    expect(topicsOnly).not.toContain(`Fact: ${repeatedTopic}`);
    expect(topicsOnly.match(/Use the current release contract\./g)).toHaveLength(1);
    expect(topicDetail).not.toContain(`Fact: ${repeatedTopic}`);
    expect(topicDetail.match(/Use the current release contract\./g)).toHaveLength(1);
  });

  it("omits static Memory availability chrome and zero-data summaries", () => {
    const runtime = {
      runtime: "in-process",
      provider: "openai-compatible",
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      modelId: "gpt-test",
      fallbackModelIds: [],
      credentialConfigured: false,
      providerTimeoutMs: 15_000,
      providerMaxRetries: 1,
      runTimeoutMs: 120_000,
      maxContinuations: 4,
      schemaVersion: 2,
      memoryEnabled: true,
      memoryWorkspaceScopeId: "default",
      memoryBackend: "memory",
      memoryColdBackend: "local",
    } satisfies RuntimeStatus;
    const panel = renderToStaticMarkup(<MemoryPanel runtime={runtime} onClose={() => undefined} />);

    expect(panel).not.toContain("memory-live");
    expect(panel).not.toContain(">Enabled<");
    expect(panel).not.toContain("Filter memory kind");
    expect(panel).not.toContain("Policy protected");
    expect(panel).not.toContain("<dl>");
  });

  it("omits empty Memory detail routes and provenance", () => {
    const record: WarmMemory = {
      id: "memory-1",
      kind: "fact",
      tier: "warm",
      scope: { type: "workspace", id: "default" },
      title: "Release policy",
      content: "Use the current release contract.",
      summary: "Use the current release contract.",
      topicIds: [],
      entityIds: [],
      status: "active",
      confidence: 0.9,
      importance: 0.8,
      sourceRefs: [],
      createdAt: 1,
      updatedAt: 2,
    };
    const renderRecord = (value: WarmMemory) => renderToStaticMarkup(<RecordDetail
      record={value}
      onForget={() => undefined}
      onRestore={() => undefined}
      onGovern={() => undefined}
      onCorrect={() => undefined}
      onFeedback={() => undefined}
    />);
    const empty = renderRecord(record);
    const populated = renderRecord({
      ...record,
      topicIds: ["release"],
      sourceRefs: [{ sourceType: "message", sourceId: "message-1" }],
    });
    const disputed = renderRecord({ ...record, status: "disputed" });
    const forgotten = renderRecord({ ...record, status: "deleted" });

    expect(empty).not.toContain("Topic routes");
    expect(empty).not.toContain("Provenance");
    expect(empty).not.toContain("No topic route");
    expect(empty).not.toContain("No source reference");
    expect(populated).toContain("Topic routes");
    expect(populated).toContain(">release<");
    expect(populated).toContain("Provenance");
    expect(populated).toContain("message:message-1");
    expect(populated).toContain("Correct");
    expect(populated).toContain("Confirm");
    expect(populated).toContain("Helpful");
    expect(populated).toContain("Wrong");
    expect(disputed).toContain("Resolve as valid");
    expect(disputed).toContain("Quarantine");
    expect(forgotten).toContain("Restore");
    expect(forgotten).not.toContain(">Forget</button>");
  });

  it("maps Goal lifecycle states to shared semantic tones", () => {
    expect(goalStatusTone("draft")).toBe("warning");
    expect(goalStatusTone("active")).toBe("info");
    expect(goalStatusTone("paused")).toBe("warning");
    expect(goalStatusTone("ready_to_close")).toBe("warning");
    expect(goalStatusTone("completed")).toBe("success");
    expect(goalStatusTone("cancelled")).toBe("danger");
  });

  it("renders Goal supporting disclosures only when inspectable data exists", () => {
    const definition: WorkspaceGoalDefinition = {
      title: "Refine the console",
      outcome: "The console has one coherent visual language.",
      scope: [],
      nonGoals: [],
      criteria: [{ key: "visual", title: "Visual review passes", required: true }],
      completionPolicy: "user_confirm",
    };
    const goal = {
      id: "goal-1",
      workspaceId: "workspace-1",
      status: "completed",
      activeDefinitionRevisionId: "definition-1",
      activeRoadmapRevisionId: null,
      currentRunId: null,
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
      definition: {
        id: "definition-1",
        goalId: "goal-1",
        kind: "definition",
        revision: 1,
        content: definition,
        contentHash: "definition-hash",
        sourceArtifactId: null,
        createdBy: "operator",
        createdAt: 1,
      },
      roadmap: null,
      decisions: [],
      runLinks: [],
      roadmapProgress: [],
      evidenceLinks: [],
      requiredCriteria: 1,
      verifiedCriteria: 0,
      nextAction: {
        actor: "none",
        kind: "view_result",
        title: "Goal ended",
        explanation: "Review the result and evidence.",
        primaryActionLabel: "View result",
        roadmapItemId: null,
      },
    } satisfies WorkspaceGoal;
    const renderGoal = (value: WorkspaceGoal) => renderToStaticMarkup(<GoalView
      goal={value}
      busy={false}
      decide={async () => undefined}
      onGenerateRoadmap={async () => undefined}
      onStartRoadmapItem={async () => undefined}
      onEditDefinition={() => undefined}
      onEditRoadmap={() => undefined}
      onOpenRun={() => undefined}
    />);
    const empty = renderGoal(goal);
    const awaitingRoadmap = renderGoal({
      ...goal,
      status: "active",
      completedAt: null,
      nextAction: {
        actor: "system",
        kind: "generate_roadmap",
        title: "Generate a Goal Roadmap",
        explanation: "Use one bounded LLM call to draft TaskRun-sized outcomes, then edit and approve them.",
        primaryActionLabel: "Generate Roadmap",
        roadmapItemId: null,
      },
    });
    const readyToClose = renderGoal({
      ...goal,
      status: "ready_to_close",
      completedAt: null,
      verifiedCriteria: 1,
      nextAction: {
        actor: "user",
        kind: "view_result",
        title: "Verified criteria are ready",
        explanation: "Review the evidence and confirm closure.",
        primaryActionLabel: "Confirm closure",
        roadmapItemId: null,
      },
    });
    const populated = renderGoal({
      ...goal,
      definition: { ...goal.definition, content: { ...definition, scope: ["Web console"] } },
      decisions: [{
        id: "decision-1", requestId: "request-1", payloadHash: "payload-hash", goalId: goal.id,
        targetRevisionId: "definition-1", targetHash: "definition-hash", kind: "approve_goal",
        approvedItemIds: [], reason: "Ready to execute", actorId: "operator", createdAt: 1,
      }],
      evidenceLinks: [{
        id: "evidence-1", goalId: goal.id, goalRevision: 1, criterionKey: "visual", runId: "run-1234567890",
        checkKey: "visual-review", artifactId: "artifact-123456", operationId: null, sourceDigest: "digest",
        status: "valid", createdAt: 2, updatedAt: 2,
      }],
      runLinks: [{
        goalId: goal.id,
        runId: "run-1234567890",
        goalRevision: 1,
        roadmapRevisionId: "roadmap-1",
        roadmapItemIds: ["item-1"],
        criterionKeys: ["visual"],
        mode: "roadmap",
        createdAt: 2,
      }],
    });
    const cancelled = renderGoal({ ...goal, status: "cancelled" });
    const roadmap = {
      id: "roadmap-1",
      goalId: goal.id,
      kind: "roadmap" as const,
      revision: 1,
      content: {
        summary: "One bounded item",
        items: [{ id: "item-1", title: "Inspect blocked Run", outcome: "Run is visible", verification: "Open it", criterionKeys: ["visual"] }],
      },
      contentHash: "roadmap-hash",
      sourceArtifactId: null,
      createdBy: "operator",
      createdAt: 2,
    };
    const approval = {
      id: "approval-1",
      requestId: "approval-request-1",
      payloadHash: "approval-payload-hash",
      goalId: goal.id,
      targetRevisionId: roadmap.id,
      targetHash: roadmap.contentHash,
      kind: "approve_roadmap" as const,
      approvedItemIds: ["item-1"],
      reason: "",
      actorId: "operator",
      createdAt: 2,
    };
    const blockedProgress = {
      goalId: goal.id,
      roadmapRevisionId: roadmap.id,
      itemId: "item-1",
      status: "blocked" as const,
      runId: "blocked-run",
      runStatus: "blocked" as const,
      retryable: false,
      updatedAt: 3,
      completedAt: null,
    };
    const blockedRoadmapGoal = {
      ...goal,
      status: "active" as const,
      completedAt: null,
      activeRoadmapRevisionId: roadmap.id,
      roadmap,
      decisions: [approval],
      roadmapProgress: [blockedProgress],
      nextAction: {
        actor: "user" as const,
        kind: "resolve_problem" as const,
        title: "A Roadmap TaskRun needs attention",
        explanation: "Open the original Run.",
        primaryActionLabel: "Open task",
        roadmapItemId: "item-1",
        taskRunId: "blocked-run",
      },
    } satisfies WorkspaceGoal;
    const nonRetryable = renderGoal(blockedRoadmapGoal);
    const retryable = renderGoal({
      ...blockedRoadmapGoal,
      roadmapProgress: [{ ...blockedProgress, runStatus: "failed", retryable: true }],
      nextAction: { ...blockedRoadmapGoal.nextAction, kind: "run_roadmap_item", primaryActionLabel: "Retry TaskRun" },
    });

    expect(empty).not.toContain("Scope and boundaries");
    expect(empty).not.toContain("Linked TaskRuns");
    expect(empty).not.toContain("Roadmap v");
    expect(empty).not.toContain("No Roadmap yet");
    expect(empty).not.toContain("Approve the Goal, then generate its initial Roadmap.");
    expect(empty).not.toContain("Next action");
    expect(empty).not.toContain("Goal ended");
    expect(empty).not.toContain("goal-progress-track");
    expect(empty).not.toContain("0% of required criteria verified");
    expect(empty).not.toContain("No explicit scope items");
    expect(empty).not.toContain("No TaskRun is linked yet");
    expect(awaitingRoadmap).toContain("Next action");
    expect(awaitingRoadmap).toContain("Generate Roadmap");
    expect(awaitingRoadmap).toContain("Create manually");
    expect(awaitingRoadmap).toContain("Request a revision");
    expect(awaitingRoadmap).toContain("Request changes");
    expect(awaitingRoadmap).toContain("Operation recovery");
    expect(awaitingRoadmap).toContain("Receipt by request ID");
    expect(awaitingRoadmap).not.toContain("Roadmap v");
    expect(awaitingRoadmap).not.toContain("No Roadmap yet");
    expect(awaitingRoadmap).not.toContain("goal-progress-track");
    expect(readyToClose).toContain("Next action");
    expect(readyToClose).toContain("Verified criteria are ready");
    expect(readyToClose).toContain("Confirm closure");
    expect(readyToClose).toContain('class="goal-progress-track"');
    expect(readyToClose).toContain('aria-label="100% of required criteria verified"');
    expect(populated).toContain("Scope and boundaries");
    expect(populated).toContain("1 item");
    expect(populated).not.toContain("1 items");
    expect(populated).toContain("Linked TaskRuns");
    expect(populated).toContain("Activity and audit");
    expect(populated).toContain("1 linked");
    expect(populated).toContain("1 Roadmap item");
    expect(populated).toContain("Evidence log");
    expect(populated).toContain("Valid · run run-1234567");
    expect(populated).toContain("Decision history");
    expect(populated).toContain("Goal approved");
    expect(cancelled).toContain('data-tone="danger"');
    expect(cancelled).toContain("Cancelled");
    expect(nonRetryable).toContain(">Open</button>");
    expect(nonRetryable).not.toContain(">Retry</button>");
    expect(nonRetryable).toContain("Open task");
    expect(retryable).toContain(">Retry</button>");
  });

  it("applies workspace and new-run view transitions atomically", () => {
    const active = run({
      checkpoint: {
        runId: "run-1",
        attempt: 1,
        active: true,
        assistantPartial: "working",
        currentTool: { toolCallId: "call-1", toolName: "read" },
        lastEventSeq: 4,
        lastTranscriptSeq: 2,
        updatedAt: 10,
      },
    });
    const snapshot = runViewFromWorkspaceSnapshot({
      sessionId: "session-1",
      history: [],
      runHistory: [active],
      queued: [],
      active,
      latest: active,
      transcript: [{ seq: 2, index: 0, attempt: 1, kind: "assistant", text: "persisted", createdAt: 9 }],
      transcriptAfter: 2,
    });
    expect(snapshot).toMatchObject({
      activeRun: active,
      selectedRun: active,
      runs: [active],
      expandedRunId: active.id,
      streaming: "working",
      liveThinking: "",
    });
    expect(snapshot.events).toEqual([{ runId: active.id, seq: 4, type: "tool.started", data: active.checkpoint!.currentTool, createdAt: 10 }]);

    const next = run({ id: "run-2", updatedAt: 20 });
    expect(runViewForStartedRun(snapshot, next)).toMatchObject({
      activeRun: next,
      selectedRun: next,
      runs: [next, active],
      expandedRunId: next.id,
      events: [],
      transcript: [],
      streaming: "",
      liveThinking: "",
    });

    const resumed = run({ ...active, status: "running", updatedAt: 11 });
    expect(runViewForResumedRun(snapshot, resumed)).toMatchObject({
      activeRun: resumed,
      selectedRun: resumed,
      runs: [resumed],
      events: [],
      transcript: snapshot.transcript,
      streaming: "",
      liveThinking: "",
    });

    const parallel = run({ id: "run-2", updatedAt: 12 });
    const refreshed = run({ ...active, updatedAt: 12 });
    const resolved = runViewForResolvedRuns(snapshot, [parallel, refreshed], false);
    expect(resolved).toMatchObject({
      activeRun: refreshed,
      selectedRun: refreshed,
      runs: [parallel, refreshed],
      events: snapshot.events,
      streaming: "working",
    });
    expect(runViewForResolvedRuns(snapshot, [refreshed], true)).toMatchObject({
      events: [],
      streaming: "",
      liveThinking: "",
    });
  });

  it("advances 501 paged items without duplicates or skips", () => {
    const source = Array.from({ length: 501 }, (_, index) => ({ id: `item-${500 - index}`, order: 500 - index }));
    let after: { order: number; id: string } | undefined;
    let loaded: typeof source = [];
    do {
      const page = source
        .filter((item) => !after || item.order < after.order || item.order === after.order && item.id < after.id)
        .slice(0, MEMORY_PAGE_REQUEST_LIMIT);
      const next = memoryPageWindow(page, (item) => ({ order: item.order, id: item.id }));
      loaded = mergeMemoryPage(loaded, next.items, (item) => item.id);
      after = next.hasMore ? next.after : undefined;
    } while (after);
    expect(loaded.map((item) => item.id)).toEqual(source.map((item) => item.id));
    expect(new Set(loaded.map((item) => item.id)).size).toBe(501);
  });

  it("rejects stale workspace and stream writers after authority changes", () => {
    const coordinator = new WorkspaceLiveSyncCoordinator();
    const firstWorkspace = coordinator.enterWorkspace("workspace");
    const firstStream = coordinator.beginStream(firstWorkspace, "run-1")!;
    expect(coordinator.markStreamHealthy(firstStream, 100)).toBe(true);
    const staleSnapshot = coordinator.snapshotGuard(firstWorkspace);
    coordinator.noteStreamActivity(firstStream, 110);
    expect(coordinator.commitSnapshot(staleSnapshot, 120)).toBe(false);

    coordinator.enterWorkspace("other");
    const currentWorkspace = coordinator.enterWorkspace("workspace");
    expect(coordinator.isWorkspaceCurrent(firstWorkspace)).toBe(false);
    expect(coordinator.noteStreamActivity(firstStream, 130)).toBe(false);
    expect(coordinator.isWorkspaceCurrent(currentWorkspace)).toBe(true);
  });

  it("opens an event stream only for an active Run owned by the current Workspace", () => {
    expect(shouldStreamWorkspaceRun(run({ sessionId: "workspace-1" }), "workspace-1")).toBe(true);
    expect(shouldStreamWorkspaceRun(run({ sessionId: "workspace-1" }), "workspace-2")).toBe(false);
    expect(shouldStreamWorkspaceRun(run({ sessionId: "workspace-1", status: "completed" }), "workspace-1")).toBe(false);
  });

  it("backs off reconnects to a cap, rejects parallel timers, and resets after health", () => {
    const backoff = new WorkspaceReconnectBackoff();
    expect(backoff.nextDelay(() => 1)).toBe(1_000);
    expect(backoff.nextDelay(() => 1)).toBeNull();
    backoff.fired();
    expect(backoff.nextDelay(() => 1)).toBe(2_000);
    backoff.fired();
    const delays = Array.from({ length: 8 }, () => { const delay = backoff.nextDelay(() => 1)!; backoff.fired(); return delay; });
    expect(delays.at(-1)).toBe(30_000);
    backoff.reset();
    expect(backoff.nextDelay(() => 0)).toBe(750);
  });

  it("clears terminal live output whenever the refreshed Run has authoritative output", () => {
    const assistant = (text: string) => ({ seq: 1, index: 0, attempt: 1, kind: "assistant" as const, text, createdAt: 1 });
    expect(terminalStreamingAfterRefresh("complete output", [assistant("complete output")], "")).toBe("");
    expect(terminalStreamingAfterRefresh("complete", [assistant("complete output")], "")).toBe("");
    expect(terminalStreamingAfterRefresh("complete   output", [assistant("complete output")], "")).toBe("");
    expect(terminalStreamingAfterRefresh("unrelated stale buffer", [assistant("authoritative output")], "")).toBe("");
    expect(terminalStreamingAfterRefresh("only unpersisted fragment", [], "")).toBe("only unpersisted fragment");
    expect(terminalStreamingAfterRefresh("event output", [], "authoritative terminal response")).toBe("");
  });

  it("lets only the latest artifact preview request commit", async () => {
    const authority = new LatestRequestAuthority();
    let committed = "";
    let releaseFirst!: (value: string) => void;
    let releaseSecond!: (value: string) => void;
    const first = new Promise<string>((resolve) => { releaseFirst = resolve; });
    const second = new Promise<string>((resolve) => { releaseSecond = resolve; });
    const open = async (request: Promise<string>) => {
      const token = authority.begin();
      const value = await request;
      if (authority.isCurrent(token)) committed = value;
    };
    const firstOpen = open(first);
    const secondOpen = open(second);
    releaseSecond("artifact B");
    await secondOpen;
    releaseFirst("artifact A");
    await firstOpen;
    expect(committed).toBe("artifact B");
  });

  it("keys requested-input forms by request and submits only current declared fields", () => {
    const request = (id: string, keys: string[]) => ({ id, fields: keys.map((key) => ({ key })) });
    const first = request("request-a", ["email"]);
    const second = request("request-b", ["confirmation_code"]);
    expect(userInputRequestKey(first)).not.toBe(userInputRequestKey(second));
    expect(userInputValuesForRequest(second, { email: "stale@example.test", confirmation_code: "123456", extra: "stale" }))
      .toEqual({ confirmation_code: "123456" });
  });

  it("rejects stale Skill catalog writers after a Workspace switch", () => {
    const authority = new WorkspaceSkillAuthority();
    const firstWorkspace = authority.enterWorkspace("workspace-1");
    const committed: string[] = [];
    const commit = (token: ReturnType<WorkspaceSkillAuthority["capture"]>, value: string) => {
      if (authority.isCurrent(token)) committed.push(value);
    };

    const secondWorkspace = authority.enterWorkspace("workspace-2");
    commit(firstWorkspace, "stale catalog");
    commit(secondWorkspace, "current catalog");

    expect(committed).toEqual(["current catalog"]);
    expect(authority.capture()).toEqual(secondWorkspace);
  });

  it("uses fresh SSE activity as authority and requests snapshot recovery after disconnect", () => {
    const coordinator = new WorkspaceLiveSyncCoordinator();
    const workspace = coordinator.enterWorkspace("workspace");
    const stream = coordinator.beginStream(workspace, "run-1")!;
    coordinator.markStreamHealthy(stream, 1_000);
    expect(coordinator.hasFreshStream(workspace, "run-1", 10_000)).toBe(true);
    expect(coordinator.hasFreshStream(workspace, "run-1", 20_000)).toBe(false);

    const recoverySnapshot = coordinator.snapshotGuard(workspace);
    expect(coordinator.commitSnapshot(recoverySnapshot, 20_000)).toBe(true);
    expect(coordinator.hasFreshStream(workspace, "run-1", 20_001)).toBe(true);

    coordinator.closeStream(stream, true);
    expect(coordinator.hasFreshStream(workspace, "run-1", 20_002)).toBe(false);
    expect(coordinator.consumeRecoveryRequest(workspace)).toBe(true);
    expect(coordinator.consumeRecoveryRequest(workspace)).toBe(false);
  });

  it("adds presentation activity baselines without rewriting established values", () => {
    const current = { existing: 10 };
    const session = (id: string, updatedAt: number): Session => ({
      id,
      title: id,
      modelId: "model",
      reasoningEffort: "medium",
      createdAt: 1,
      updatedAt,
      latestRunStatus: null,
      latestRunPhase: null,
    });
    const unchanged = mergeWorkspaceActivityBaseline(current, [session("existing", 20)]);
    expect(unchanged).toBe(current);
    expect(mergeWorkspaceActivityBaseline(current, [
      session("existing", 20),
      session("new", 30),
    ])).toEqual({ existing: 10, new: 30 });
  });

  it("omits empty Workspace groups and distinguishes an empty collection from an empty filter", () => {
    const session = (id: string, title: string): Session => ({
      id,
      title,
      modelId: "model",
      reasoningEffort: "medium",
      createdAt: 1,
      updatedAt: 1,
      latestRunStatus: null,
      latestRunPhase: null,
    });
    const alpha = session("alpha", "Alpha release");
    const beta = session("beta", "Beta review");

    expect(deriveWorkspaceNavigation([], [], "")).toEqual({
      groups: [],
      emptyState: {
        kind: "no-workspaces",
        title: "No workspaces yet",
        detail: "Create one to start a task.",
      },
    });
    expect(deriveWorkspaceNavigation([alpha, beta], [alpha.id], "")).toEqual({
      groups: [
        { label: "Pinned", workspaces: [alpha] },
        { label: "Recent", workspaces: [beta] },
      ],
      emptyState: null,
    });
    expect(deriveWorkspaceNavigation([alpha, beta], [alpha.id], "beta")).toEqual({
      groups: [{ label: "Matches", workspaces: [beta] }],
      emptyState: null,
    });
    expect(deriveWorkspaceNavigation([alpha, beta], [alpha.id], "missing")).toEqual({
      groups: [],
      emptyState: workspaceEmptyState(2, 0),
    });
    expect(workspaceEmptyState(2, 0)).toEqual({
      kind: "no-matches",
      title: "No matching workspaces",
      detail: "Try another name or clear the filter.",
    });
  });

  it("navigates Workspace composer history and restores the unfinished draft", () => {
    let view: ComposerHistoryView = { cursor: null, draft: "unfinished", seed: "" };
    view = nextComposerHistoryView(["first", "latest"], -1, view);
    expect(view).toEqual({ cursor: 1, draft: "latest", seed: "unfinished" });
    view = nextComposerHistoryView(["first", "latest"], -1, view);
    expect(view).toEqual({ cursor: 0, draft: "first", seed: "unfinished" });
    expect(nextComposerHistoryView(["first", "latest"], -1, view)).toEqual(view);
    view = nextComposerHistoryView(["first", "latest"], 1, view);
    expect(view).toEqual({ cursor: 1, draft: "latest", seed: "unfinished" });
    expect(nextComposerHistoryView(["first", "latest"], 1, view)).toEqual({ cursor: null, draft: "unfinished", seed: "unfinished" });
  });

  it("keeps composer geometry and status tone mapping behind shared authorities", () => {
    expect(clampComposerHeight(20, 36, 140)).toBe(36);
    expect(clampComposerHeight(88, 36, 140)).toBe(88);
    expect(clampComposerHeight(220, 36, 140)).toBe(140);
    expect(runStatusTone("running")).toBe("info");
    expect(runStatusTone("completed")).toBe("success");
    expect(runStatusTone("blocked")).toBe("warning");
    expect(runStatusTone("failed")).toBe("danger");
    expect(runStatusTone("queued")).toBeUndefined();
  });

  it("replaces a pending tool projection with its later completed result", () => {
    const pending = {
      seq: 1, index: 0, attempt: 1, kind: "tool", toolCallId: "call-1", toolName: "read",
      arguments: { path: "a.txt" }, result: "", isError: false, status: "pending", createdAt: 1,
    } satisfies TranscriptItem;
    const completed = {
      ...pending, seq: 2, result: "contents", status: "completed", createdAt: 2,
    } satisfies TranscriptItem;

    expect(mergeTranscriptItems([pending], [completed])).toEqual([completed]);
  });

  it("groups reasoning, its tool ledger, and model output into one execution stage", () => {
    const reasoning = { seq: 1, attempt: 1, kind: "thinking", text: "Inspect the UI structure", redacted: false, createdAt: 1 } satisfies TranscriptItem;
    const firstTool = { seq: 2, index: 0, attempt: 1, kind: "tool", toolCallId: "call-1", toolName: "read", arguments: {}, result: "source", isError: false, status: "completed", createdAt: 2 } satisfies TranscriptItem;
    const secondTool = { ...firstTool, seq: 3, toolCallId: "call-2", toolName: "bash", result: "passed", createdAt: 3 } satisfies TranscriptItem;
    const output = { seq: 4, attempt: 1, kind: "assistant", text: "The refinement is complete.", createdAt: 4 } satisfies TranscriptItem;

    const groups = groupExecutionItems([reasoning, firstTool, secondTool, output]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.reasoning).toBe(reasoning);
    expect(groups[0]?.tools).toEqual([firstTool, secondTool]);
    expect(groups[0]?.output).toBe(output);
  });

  it("keeps non-tool transcript items ordered while deduplicating exact projections", () => {
    const assistant = { seq: 3, index: 0, attempt: 1, kind: "assistant", text: "done", createdAt: 3 } satisfies TranscriptItem;
    const user = { seq: 1, attempt: 1, kind: "user", text: "start", createdAt: 1 } satisfies TranscriptItem;
    expect(mergeTranscriptItems([assistant], [user, assistant])).toEqual([user, assistant]);
  });

  it("keeps paged conversation history while replacing the refreshed live window", () => {
    const message = (id: number, content: string): Message => ({
      id,
      sessionId: "session-1",
      role: "assistant",
      content,
      createdAt: id,
    });
    const current = [message(1, "older-1"), message(2, "older-2"), message(3, "stale"), message(4, "current")];
    const latest = [message(3, "persisted"), message(4, "current"), message(5, "new")];

    expect(mergeRefreshedMessages(current, latest)).toEqual([
      message(1, "older-1"),
      message(2, "older-2"),
      ...latest,
    ]);
  });

  it("linearly merges an interleaved delta and keeps the last value for duplicate keys", () => {
    const first = { seq: 1, attempt: 1, kind: "user", text: "first", createdAt: 1 } satisfies TranscriptItem;
    const stale = { seq: 3, index: 0, attempt: 1, kind: "assistant", text: "stale", createdAt: 3 } satisfies TranscriptItem;
    const current = { ...stale, text: "current" } satisfies TranscriptItem;
    const middle = { seq: 2, index: 0, attempt: 1, kind: "assistant", text: "middle", createdAt: 2 } satisfies TranscriptItem;

    expect(mergeTranscriptItems([first, stale, current], [middle])).toEqual([first, middle, current]);
  });

  it("coalesces streaming token deltas into one update per animation frame", () => {
    const callbacks = new Map<number, () => void>();
    let nextHandle = 1;
    const scheduler: FrameScheduler = {
      request(callback) { const handle = nextHandle++; callbacks.set(handle, callback); return handle; },
      cancel(handle) { callbacks.delete(handle as number); },
    };
    const apply = vi.fn();
    const batcher = createStreamingDeltaBatcher(apply, scheduler);

    for (let index = 0; index < 100; index += 1) batcher.appendOutput("x");
    batcher.appendThinking("reasoning");
    expect(callbacks).toHaveLength(1);
    expect(apply).not.toHaveBeenCalled();
    callbacks.values().next().value!();
    expect(apply).toHaveBeenCalledWith("x".repeat(100), "reasoning");
  });

  it("flushes or discards a pending streaming frame deterministically", () => {
    const callbacks = new Map<number, () => void>();
    const scheduler: FrameScheduler = {
      request(callback) { callbacks.set(1, callback); return 1; },
      cancel(handle) { callbacks.delete(handle as number); },
    };
    const apply = vi.fn();
    const batcher = createStreamingDeltaBatcher(apply, scheduler);
    batcher.appendOutput("visible");
    batcher.flush();
    expect(apply).toHaveBeenLastCalledWith("visible", "");
    expect(callbacks).toHaveLength(0);
    batcher.appendOutput("stale");
    batcher.discard();
    expect(callbacks).toHaveLength(0);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("coalesces acknowledgements and flushes the highest cursor on time", () => {
    vi.useFakeTimers();
    const acknowledge = vi.fn();
    const cursor = createEventAcknowledger(acknowledge, 500);
    cursor.schedule(2);
    cursor.schedule(7);
    cursor.schedule(4);
    expect(acknowledge).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledWith(7);
  });

  it("flushes the final acknowledgement when a stream unmounts", () => {
    vi.useFakeTimers();
    const acknowledge = vi.fn();
    const cursor = createEventAcknowledger(acknowledge);
    cursor.schedule(9);
    cursor.close();
    vi.runAllTimers();
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledWith(9);
    cursor.schedule(10);
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it("classifies active and resumable Runs without bypassing pending approvals", () => {
    expect(["running", "waiting_input", "blocked"].every((status) =>
      isActiveRunStatus(status as TaskRun["status"]))).toBe(true);
    expect(isActiveRunStatus("interrupted")).toBe(false);
    expect(findActiveRun([
      run({ id: "done", status: "completed" }),
      run({ id: "blocked", status: "blocked" }),
    ])?.id).toBe("blocked");

    const interrupted = run({ status: "interrupted", resumable: true });
    expect(canResumeRun(interrupted, null)).toBe(true);
    expect(canResumeRun(run({
      resumable: true,
      supervision: { ...interrupted.supervision, approvalRequests: [{ status: "pending" } as RunApproval] },
    }), null)).toBe(false);
  });

  it("formats run enums as deliberate sentence case without CSS data rewriting", () => {
    expect(formatRunStatus(null)).toBe("");
    expect(formatRunStatus("waiting_input")).toBe("Needs input");
    expect(formatRunStatus("completed")).toBe("Completed");
    expect(formatRunValue("tool_execution")).toBe("Tool execution");
    expect(isRedundantRunPhase("completed", "done")).toBe(true);
    expect(isRedundantRunPhase("waiting_input", "waiting_input")).toBe(true);
    expect(isRedundantRunPhase("running", "implement")).toBe(false);
  });

  it("renders Run explanations only for statuses that need attention", () => {
    expect(runStatusNotice("completed", "visual audit fixture")).toBeNull();
    expect(runStatusNotice("running", "resumed")).toBeNull();
    expect(runStatusNotice("blocked", "External evidence is missing")).toEqual({
      text: "External evidence is missing", tone: "warning",
    });
    expect(runStatusNotice("waiting_input", "Choose a target")).toEqual({
      text: "Choose a target", tone: "warning",
    });
    expect(runStatusNotice("failed", "Provider failed")).toEqual({ text: "Provider failed", tone: "danger" });
    expect(runStatusNotice("cancelled", "Cancelled by user")).toEqual({ text: "Cancelled by user", tone: "danger" });
    expect(runStatusNotice("interrupted", "Core restarted")).toEqual({ text: "Core restarted", tone: "danger" });

    const completed = renderToStaticMarkup(<RunDetails run={run({
      status: "completed", phase: "done", blockedReason: "visual audit fixture",
    })} toolEvents={[]} transcriptTools={[]} />);
    const blocked = renderToStaticMarkup(<RunDetails run={run({
      status: "blocked", phase: "blocked", blockedReason: "External evidence is missing",
    })} toolEvents={[]} transcriptTools={[]} />);
    const failed = renderToStaticMarkup(<RunDetails run={run({
      status: "failed", blockedReason: "Provider failed",
    })} toolEvents={[]} transcriptTools={[]} />);
    const diagnostic = renderToStaticMarkup(<RunDetails run={run({
      status: "blocked",
      blockedReason: "semantic_review_unavailable: Semantic review was unavailable; acceptance_criterion_1: Evidence was not mapped to this criterion because the independent judge was unavailable.",
    })} toolEvents={[]} transcriptTools={[]} />);

    expect(completed).not.toContain("visual audit fixture");
    expect(completed).not.toContain("run-status-note");
    expect(blocked).toContain('class="run-status-note" data-tone="warning"');
    expect(blocked).toContain("External evidence is missing");
    expect(failed).toContain('class="run-status-note" data-tone="danger"');
    expect(failed).toContain("Provider failed");
    expect(diagnostic).toContain('<details class="run-status-note" data-tone="warning">');
    expect(diagnostic).toContain("Semantic review was unavailable");
    expect(diagnostic).toContain("semantic_review_unavailable:");
  });

  it("deduplicates intent prefetches, expires old values, and retries failures", async () => {
    let now = 0;
    const cache = new IntentPrefetchCache<string, string>(10, 2, () => now);
    const loader = vi.fn(async () => "workspace");
    const first = cache.load("one", loader);
    const second = cache.load("one", loader);
    expect(first).toBe(second);
    await expect(first).resolves.toBe("workspace");
    expect(cache.peek("one")).toBe("workspace");
    expect(loader).toHaveBeenCalledOnce();

    now = 11;
    expect(cache.peek("one")).toBeUndefined();
    const failure = vi.fn(async () => { throw new Error("offline"); });
    await expect(cache.load("two", failure)).rejects.toThrow("offline");
    await expect(cache.load("two", failure)).rejects.toThrow("offline");
    expect(failure).toHaveBeenCalledTimes(2);
  });

  it("loads an empty workspace snapshot without hydrating nonexistent Runs", async () => {
    vi.spyOn(api, "messages").mockResolvedValue([]);
    vi.spyOn(api, "runs").mockResolvedValue([]);
    vi.spyOn(api, "inbox").mockResolvedValue([]);
    const hydrate = vi.spyOn(api, "run");
    await expect(loadWorkspaceSnapshot("session-1")).resolves.toEqual({
      sessionId: "session-1", history: [], runHistory: [], queued: [], active: null, latest: null,
      transcript: [], transcriptAfter: 0,
    });
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("validates persisted workspace preferences instead of trusting arbitrary JSON", () => {
    const values = new Map([
      ["strings", JSON.stringify({ valid: "value", invalid: 1 })],
      ["lists", JSON.stringify({ valid: ["one", "two"], invalid: [1] })],
      ["tagent.gate-profiles", JSON.stringify({ one: "strict", two: "unknown" })],
      ["tagent.workspace-emojis", JSON.stringify({ one: "🧠", invalid: 1 })],
    ]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null });
    expect(storedStringRecord("strings")).toEqual({ valid: "value" });
    expect(storedStringLists("lists")).toEqual({ valid: ["one", "two"] });
    expect(storedGateProfiles()).toEqual({ one: "strict" });
    expect(storedStringRecord("tagent.workspace-emojis")).toEqual({ one: "🧠" });
  });

  it("merges earlier conversation pages without duplicates and recognizes a full page", () => {
    const message = (id: number): Message => ({
      id, sessionId: "workspace-1", role: id % 2 ? "user" : "assistant", content: `Message ${id}`, createdAt: id,
    });

    expect(mergeEarlierMessages([message(3), message(4)], [message(1), message(2), message(3)]).map((item) => item.id))
      .toEqual([1, 2, 3, 4]);
    expect(messagePageHasOlderHint(Array.from({ length: 80 }, (_, index) => message(index)))).toBe(true);
    expect(messagePageHasOlderHint([message(1)])).toBe(false);
  });

  it("rejects stale earlier-message pages after a Workspace round trip", () => {
    const authority = new ConversationHistoryAuthority();
    authority.enter("workspace-a");
    const stale = authority.capture("workspace-a")!;
    authority.enter("workspace-b");
    authority.enter("workspace-a");
    const current = authority.capture("workspace-a")!;

    expect(authority.isCurrent(stale)).toBe(false);
    expect(authority.isCurrent(current)).toBe(true);
    expect(authority.capture("workspace-b")).toBeNull();
  });

  it("indexes only the newest user-message Memory annotation", () => {
    const capture = (id: string, updatedAt: number, sourceId: string, kind = "user_message"): CaptureJob => ({
      id, status: "completed", attempts: 1, createdAt: 1, updatedAt,
      request: {
        sourceRefs: [{ sourceType: "message", sourceId }],
        captureSource: { kind, role: kind === "assistant_message" ? "assistant" : "user" },
      },
    });
    const newest = capture("new", 3, "41");
    const indexed = indexMemoryJobsByMessage([
      capture("old", 1, "41"),
      newest,
      capture("assistant", 4, "42", "assistant_message"),
      capture("invalid", 5, "not-a-number"),
    ]);

    expect(indexed.get(41)).toBe(newest);
    expect(indexed.has(42)).toBe(false);
    expect(indexed.size).toBe(1);
  });

  it("keeps a reader unpinned after an upward scroll and repins at the live edge", () => {
    expect(nextConversationPinState({
      pinned: true, previousTop: 100, nextTop: 90, gap: 500,
      viewportResized: false, settling: false, programmatic: false,
    })).toBe(false);
    expect(nextConversationPinState({
      pinned: false, previousTop: 90, nextTop: 90, gap: 20,
      viewportResized: false, settling: false, programmatic: false,
    })).toBe(true);
  });

  it("derives running, waiting, stalled, and terminal operation states from durable timestamps", () => {
    const active = run({
      updatedAt: 1_000,
      checkpoint: {
        runId: "run-1", active: true, attempt: 1, assistantPartial: "", lastEventSeq: 1, lastTranscriptSeq: 0,
        currentTool: { toolCallId: "call", toolName: "bash", startedAt: 1_000, lastActivityAt: 1_000 },
        updatedAt: 1_000,
      },
    });
    expect(deriveCurrentOperation(active, 2_000)).toMatchObject({ state: "running", toolName: "bash" });
    expect(deriveCurrentOperation(active, 20_000).state).toBe("waiting");
    expect(deriveCurrentOperation(active, 122_000).state).toBe("stalled");
    expect(deriveCurrentOperation(run({ status: "completed", completedAt: 5 }), 10).state).toBe("completed");
  });

  it("omits idle workspace chrome and renders meaningful status accessibly", () => {
    const idle = renderToStaticMarkup(<WorkspaceRunStatus workspace={{
      id: "session", title: "Workspace", modelId: "model", reasoningEffort: "high",
      createdAt: 1, updatedAt: 1, latestRunStatus: null, latestRunPhase: null,
    }} />);
    expect(idle).toBe("");
    const waiting = renderToStaticMarkup(<WorkspaceRunStatus workspace={{
      id: "session", title: "Workspace", modelId: "model", reasoningEffort: "high",
      createdAt: 1, updatedAt: 1, latestRunStatus: "waiting_input", latestRunPhase: "waiting_input",
    }} />);
    expect(waiting).toContain("Needs input");
    expect(waiting).not.toContain(">waiting_input<");
    const completed = renderToStaticMarkup(<WorkspaceRunStatus workspace={{
      id: "session", title: "Workspace", modelId: "model", reasoningEffort: "high",
      createdAt: 1, updatedAt: 1, latestRunStatus: "completed", latestRunPhase: "done",
    }} />);
    expect(completed).toContain('title="Completed"');
    expect(completed).not.toContain("Completed · Done");
    const divider = renderToStaticMarkup(<ConversationDateDivider value={Date.UTC(2026, 7, 16)} />);
    expect(divider).toContain('role="separator"');
    expect(renderToStaticMarkup(<TAgentMark />)).toContain('aria-hidden="true"');
  });

  it("renders message Memory annotations only for inspectable capture events", () => {
    const message = {
      id: 1, sessionId: "session-1", role: "user", content: "Remember this", createdAt: 1,
    } satisfies Message;
    const capture = (overrides: Partial<CaptureJob>): CaptureJob => ({
      id: "capture-1", status: "queued", attempts: 0, createdAt: 1, updatedAt: 1,
      request: {
        sourceRefs: [],
        captureSource: { kind: "user_message", role: "user" },
      },
      ...overrides,
    });
    const renderMessage = (memoryJob?: CaptureJob | null) => renderToStaticMarkup(
      <ConversationMessage message={message} memoryJob={memoryJob} />,
    );

    for (const markup of [
      renderMessage(),
      renderMessage(null),
      renderMessage(capture({ status: "completed_empty", proposalCount: 0, persistedCount: 0 })),
      renderMessage(capture({ status: "completed", proposalCount: 2, persistedCount: 0 })),
    ]) {
      expect(markup).not.toContain("turn-memory");
      expect(markup).not.toContain("No durable memory");
      expect(markup).not.toContain("Checking memory");
    }

    const completed = renderMessage(capture({ status: "completed", proposalCount: 2, persistedCount: 2 }));
    expect(completed).toContain('class="turn-memory" data-tone="success"');
    expect(completed).toContain("2 memories extracted");

    const running = renderMessage(capture({ status: "running", attempts: 1 }));
    expect(running).toContain('class="turn-memory" data-tone="info"');
    expect(running).toContain("Extracting durable memory…");

    const failed = renderMessage(capture({ status: "retryable_failed", attempts: 2, errorCode: "provider_timeout" }));
    expect(failed).toContain('class="turn-memory" data-tone="danger"');
    expect(failed).toContain("Extraction failed · provider_timeout");

    const pending = renderToStaticMarkup(<PendingConversationMessage content="Remember this" />);
    expect(pending).toContain("Sending…");
    expect(pending).not.toContain("turn-memory");
    expect(pending).not.toContain("Checking memory");
  });

  it("renders requested-input and approval checkpoints in the primary work area", () => {
    const input = renderToStaticMarkup(<UserInputCard
      request={{
        id: "input-1", runId: "run-1", prompt: "Choose target",
        fields: [{ key: "target", label: "Target", description: "Environment", inputType: "text", required: true, placeholder: "staging" }],
        attempt: 1, status: "pending", response: {}, requestedAt: 1, submittedAt: null,
      }}
      submitting={false}
      onSubmit={async () => undefined}
    />);
    expect(input).toContain("Information needed to continue");
    expect(input).toContain("does not approve or authorize an external action");
    expect(input).toContain("Submit and resume");
    expect(input).toContain("Target *");
    expect(input).toContain('disabled=""');

    const approval = {
      id: "approval-1", decisionId: "decision-1",
      status: "pending", actionType: "execute_external_action", targetType: "taskrun", targetId: "run-1",
      reason: "Deploy release", metadata: { approvedAttempt: 3 }, requestedAt: 1,
      resolvedAt: null, resolvedBy: "", resolution: "",
    } satisfies RunApproval;
    const dock = renderToStaticMarkup(<ApprovalDock
      run={run({ supervision: { ...run().supervision, approvalRequests: [approval] } })}
      approvals={[approval]}
      resolvingId=""
      resolvingDecision=""
      onResolve={async () => undefined}
    />);
    expect(dock).toContain("External action needs your approval");
    expect(dock).toContain("Human checkpoint · Attempt 3");
    expect(dock).toContain("Authorization is limited to Attempt 3");
    expect(dock).toContain("Approve &amp; execute");
    expect(approvalResolutionNotice("execute_external_action", "approved")).toBe("Approval recorded. External action authorized and TaskRun resumed.");
    expect(approvalResolutionNotice("start_parallel_taskrun", "approved")).toBe("Approval recorded. Parallel TaskRun started.");
    expect(approvalResolutionNotice("resume_taskrun", "rejected")).toBe("Approval rejected. TaskRun remains paused.");
  });

  it("renders a live execution trace and queued prompt controls from state", () => {
    const reasoning = { seq: 1, attempt: 1, kind: "thinking", text: "Verify the current state", redacted: false, createdAt: 1 } satisfies TranscriptItem;
    const tool = {
      seq: 2, index: 0, attempt: 1, kind: "tool", toolCallId: "call", toolName: "bash",
      arguments: { command: "npm test" }, result: "", isError: false, status: "pending", createdAt: 2,
    } satisfies TranscriptItem;
    const output = { seq: 3, attempt: 1, kind: "assistant", text: "Tests are running.", createdAt: 3 } satisfies TranscriptItem;
    const trace = renderToStaticMarkup(<ExecutionTimeline
      runId="run-1" isRunning items={[reasoning, tool, output]} events={[]} liveThinking="" liveOutput=""
    />);
    expect(trace).toContain("Execution trace");
    expect(trace).toContain("npm test");
    expect(trace).toContain("1 stage");
    expect(trace).toContain('aria-label="Stage 1 tool calls"');
    expect(trace.match(/class="run-step"/g)).toHaveLength(1);
    expect(trace).toContain('aria-expanded="true"');

    const item = {
      id: "item-1", sessionId: "session-1", content: "Fix tests", status: "queued",
      decision: "pending", runId: null, position: 0, revision: 1, createdAt: 1, updatedAt: 1,
      analysis: {
        summary: "Fix tests", intent: "new_task", targetRunId: null, priority: 10,
        urgency: "normal", relation: "independent", acceptanceCriteria: ["Tests pass"],
        confidence: 1, reason: "ready",
      },
    } as SessionInboxItem;
    const queue = renderToStaticMarkup(<QueuePrompt
      item={item} index={0} editing={false} draft={item.content} busy={false} starting={false}
      canMoveUp={false} canMoveDown={false}
      onEdit={() => undefined} onDraftChange={() => undefined} onSave={() => undefined}
      onCancelEdit={() => undefined} onStart={() => undefined} onToggleDefer={() => undefined}
      onMergeFirst={() => undefined} onDelete={() => undefined} onMoveUp={() => undefined}
      onMoveDown={() => undefined} onDragStart={() => undefined} onDragEnd={() => undefined}
      onDrop={() => undefined}
    />);
    expect(queue).toContain("Run now");
    expect(queue).toContain("Defer");
    expect(queue).toContain("Move up");
    expect(queue).toContain("Acceptance criteria");
    expect(queue).toContain("New task");
    expect(queue).toContain("Normal · priority 10");
    expect(queue).not.toContain(">new_task<");
  });

  it("formats audit enums while preserving technical model identifiers", () => {
    const details = renderToStaticMarkup(<RunDetails run={run({
      status: "completed",
      phase: "done",
      completedAt: 20,
      contract: {
        sourceInput: "Ship it", summary: "Ship it", acceptanceCriteria: ["Checks pass"],
        scope: "Repository", nonGoals: [], sourceInboxIds: [], parentRunId: null,
        relation: "follow_up", intent: "new_task", decisionReason: "New bounded work", routerVersion: "v1",
      },
      supervision: {
        latestDecision: {
          id: "decision-1", evaluator: "llm", evaluatorModel: "gpt-5.6-sol",
          action: "pause_for_approval", reasonCode: "needs_user_input", rationale: "Confirm the release target.",
          confidence: 0.9, status: "proposed", attempt: 1, checkpointSeq: 3,
        },
        latestGates: [{
          id: "gate-1", evaluator: "llm", evaluatorModel: "gpt-5.6-sol", summary: "One approval remains.",
          gateType: "completion", passed: false,
          failures: [{ kind: "approval", key: "release", reason: "Target is not confirmed.", disposition: "needs_approval" }],
          criterionCoverage: [{ criterion: "Checks pass", status: "covered", evidenceRefs: ["check:test"], reason: "Verified." }],
        }],
        progress: { meaningfulChanges: 2, consecutiveFailures: 0, repeatedOperations: 1, checkpointSeq: 3, lastProgressAt: 10 },
        approvalRequests: [], latestContextManifest: null,
      },
    })} toolEvents={[]} transcriptTools={[]} />);

    expect(details).toContain("New task · Follow up");
    expect(details).toContain("Pause for approval");
    expect(details).toContain("Needs user input");
    expect(details).toContain("Completion");
    expect(details).toContain("Needs approval");
    expect(details).toContain("Covered");
    expect(details).toContain("Acceptance standard");
    expect(details).toContain("6 rules");
    expect(details).toContain('<details class="run-contract">');
    expect(details).not.toContain('<details class="run-contract" open');
    expect(details.match(/<details class="audit-disclosure">/g)).toHaveLength(2);
    expect(details).toContain("Evaluation history");
    expect(details).toContain("1 failed");
    expect(details).not.toContain('<details class="audit-disclosure" open');
    expect(details).not.toContain("Settled candidate rejected");
    expect(details).toContain("1 blocker");
    expect(details).toContain("1 failure");
    expect(details).not.toContain("blocker(s)");
    expect(details).not.toContain("failure(s)");
    expect(details.indexOf("1 blocker")).toBeLessThan(details.indexOf("Acceptance standard"));
    expect(details).toContain("gpt-5.6-sol");
    expect(details).not.toContain(">new_task<");
    expect(details).not.toContain(">pause_for_approval<");
  });

  it("keeps terminal audit history free of inactive operation and empty checkpoint chrome", () => {
    const terminal = renderToStaticMarkup(<RunDetails run={run({
      status: "completed",
      phase: "done",
      completedAt: 20,
      checkpoint: {
        runId: "run-1", attempt: 1, active: false, assistantPartial: "", currentTool: null,
        lastEventSeq: 8, lastTranscriptSeq: 3, updatedAt: 20,
      },
    })} toolEvents={[]} transcriptTools={[]} />);
    const active = renderToStaticMarkup(<RunDetails run={run({
      checkpoint: {
        runId: "run-1", attempt: 1, active: true, assistantPartial: "Inspecting styles", currentTool: { toolCallId: "call-1", toolName: "read" },
        lastEventSeq: 4, lastTranscriptSeq: 2, updatedAt: 10,
      },
    })} toolEvents={[]} transcriptTools={[]} />);
    const preserved = renderToStaticMarkup(<RunDetails run={run({
      status: "interrupted",
      checkpoint: {
        runId: "run-1", attempt: 1, active: false, assistantPartial: "Preserved response", currentTool: null,
        lastEventSeq: 6, lastTranscriptSeq: 2, updatedAt: 15,
      },
    })} toolEvents={[]} transcriptTools={[]} />);
    const preservedWithoutPosition = renderToStaticMarkup(<RunDetails run={run({
      status: "interrupted",
      checkpoint: {
        runId: "run-1", attempt: 1, active: false, assistantPartial: "Response without a sequence", currentTool: null,
        lastEventSeq: 0, lastTranscriptSeq: 0, updatedAt: 15,
      },
    })} toolEvents={[]} transcriptTools={[]} />);

    expect(terminal).not.toContain("Current operation");
    expect(terminal).not.toContain(">Checkpoint<");
    expect(terminal).not.toContain(">Supervisor review<");
    expect(terminal).not.toContain("Observing execution");
    expect(terminal).not.toContain("monitoring progress");
    expect(terminal).not.toContain("Gate audit");
    expect(terminal).not.toContain("Structural prerequisites incomplete");
    expect(terminal).not.toContain("0 messages");
    expect(terminal).not.toContain("0 tokens");
    expect(terminal).not.toContain("token usage is observational only");
    expect(terminal).not.toContain(">Tool activity<");
    expect(terminal).not.toContain("Recorded tool calls");
    expect(terminal).not.toContain(">Plan<");
    expect(terminal).not.toContain(">Checks<");
    expect(terminal).not.toContain(">Continuations<");
    expect(terminal).not.toContain("Execution evidence");
    expect(terminal).not.toContain(">Artifacts<");
    expect(terminal).not.toContain("No structured plan");
    expect(terminal).not.toContain("No required checks");
    expect(terminal).not.toContain("No automatic continuation");
    expect(terminal).not.toContain("No artifacts");
    expect(active).toContain("Current operation");
    expect(active).not.toContain(">Checkpoint<");
    expect(active).toContain(">Supervisor review<");
    expect(active).toContain("Observing execution");
    expect(active).toContain("Gate audit · strict");
    expect(active).toContain("Plan or check prerequisites are still incomplete.");
    expect(active).not.toContain("No settled gate evaluation yet");
    expect(preserved).not.toContain("Current operation");
    expect(preserved).toContain(">Checkpoint<");
    expect(preserved).toContain("Preserved response");
    expect(preserved).toContain('<div class="audit-ledger">');
    expect(preserved).not.toContain("checkpoint-card");
    expect(preservedWithoutPosition).toContain("Response without a sequence");
    expect(preservedWithoutPosition).not.toContain("event 0");
    expect(preservedWithoutPosition).not.toContain("transcript 0");
  });

  it("does not repeat an identical Gate failure kind and key", () => {
    const markup = renderToStaticMarkup(<RunDetails run={run({
      completionGate: {
        passed: false,
        failures: [
          { kind: "plan", key: "plan", reason: "No required plan items" },
          { kind: "check", key: "lint", reason: "Lint evidence is missing" },
        ],
      },
    })} toolEvents={[]} transcriptTools={[]} />);

    expect(markup).toContain('<div class="gate-detail"><span>Plan</span><p>No required plan items</p></div>');
    expect(markup).not.toContain("<strong>Plan</strong>");
    expect(markup).toContain('<div class="gate-detail"><span>Check</span><strong>Lint</strong><p>Lint evidence is missing</p></div>');
  });

  it("retains recorded Supervisor evidence without live-monitoring copy after a run settles", () => {
    const progressOnly = renderToStaticMarkup(<RunDetails run={run({
      status: "completed",
      phase: "done",
      completedAt: 20,
      supervision: {
        ...run().supervision,
        progress: { meaningfulChanges: 3, consecutiveFailures: 1, repeatedOperations: 2, checkpointSeq: 7, lastProgressAt: 18 },
      },
    })} toolEvents={[]} transcriptTools={[]} />);

    expect(progressOnly).toContain(">Supervisor review<");
    expect(progressOnly).toContain("Recorded progress");
    expect(progressOnly).toContain("3 meaningful changes");
    expect(progressOnly).toContain("1 consecutive failure");
    expect(progressOnly).toContain("2 repeated operations");
    expect(progressOnly).not.toContain("0 meaningful changes");
    expect(progressOnly).not.toContain("Observing execution");
    expect(progressOnly).not.toContain("monitoring progress");
    expect(progressOnly).not.toContain("Gate audit");
  });

  it("omits zero-only Supervisor evidence after settlement and observes it only while running", () => {
    const zeroProgress = { meaningfulChanges: 0, consecutiveFailures: 0, repeatedOperations: 0, checkpointSeq: 7, lastProgressAt: 18 };
    const terminal = renderToStaticMarkup(<RunDetails run={run({
      status: "completed", phase: "done", completedAt: 20,
      supervision: { ...run().supervision, progress: zeroProgress },
    })} toolEvents={[]} transcriptTools={[]} />);
    const active = renderToStaticMarkup(<RunDetails run={run({
      supervision: { ...run().supervision, progress: zeroProgress },
    })} toolEvents={[]} transcriptTools={[]} />);

    expect(terminal).not.toContain(">Supervisor review<");
    expect(terminal).not.toContain("Recorded progress");
    expect(active).toContain(">Supervisor review<");
    expect(active).toContain("Observing execution");
    expect(active).not.toContain("Recorded progress");
    expect(active).not.toContain("0 meaningful changes");
    expect(active).not.toContain("0 consecutive failures");
    expect(active).not.toContain("0 repeated operations");
  });

  it("renders only populated Context manifest summaries and disclosures", () => {
    const manifest = {
      id: "manifest-1", runId: "run-1", attempt: 1, source: "session" as const,
      items: [{ kind: "user_prompt" as const, sourceId: "prompt-1", selected: true, reason: "current input", estimatedTokens: 0 }],
      stats: {}, manifestHash: "abcdef1234567890", createdAt: 10,
    };
    const selectedOnly = renderToStaticMarkup(<RunDetails run={run({
      status: "completed", phase: "done", completedAt: 20,
      supervision: { ...run().supervision, latestContextManifest: manifest },
    })} toolEvents={[]} transcriptTools={[]} />);
    const withOmitted = renderToStaticMarkup(<RunDetails run={run({
      status: "completed", phase: "done", completedAt: 20,
      supervision: {
        ...run().supervision,
        latestContextManifest: {
          ...manifest,
          items: [
            { ...manifest.items[0], estimatedTokens: 42 },
            { kind: "session_message" as const, sourceId: "message-1", selected: false, reason: "outside recent-turn policy", estimatedTokens: 12 },
          ],
        },
      },
    })} toolEvents={[]} transcriptTools={[]} />);
    const empty = renderToStaticMarkup(<RunDetails run={run({
      status: "completed", phase: "done", completedAt: 20,
      supervision: { ...run().supervision, latestContextManifest: { ...manifest, items: [] } },
    })} toolEvents={[]} transcriptTools={[]} />);
    const omittedOnly = renderToStaticMarkup(<RunDetails run={run({
      status: "completed", phase: "done", completedAt: 20,
      supervision: {
        ...run().supervision,
        latestContextManifest: {
          ...manifest,
          items: [{ kind: "session_message" as const, sourceId: "message-1", selected: false, reason: "outside recent-turn policy", estimatedTokens: 12 }],
        },
      },
    })} toolEvents={[]} transcriptTools={[]} />);

    expect(selectedOnly).toContain('<details class="audit-section audit-disclosure">');
    expect(selectedOnly).toContain(">Context manifests<");
    expect(selectedOnly).toContain("1 selected");
    expect(selectedOnly).toContain("hash abcdef123456");
    expect(selectedOnly).toContain("Selected sources");
    expect(selectedOnly).not.toContain("retained");
    expect(selectedOnly).not.toContain("0 omitted");
    expect(selectedOnly).not.toContain("0 estimated tokens");
    expect(selectedOnly).not.toContain("Omitted sources");
    expect(selectedOnly).not.toContain(">None<");
    expect(selectedOnly).not.toContain("Changes from previous manifest");
    expect(withOmitted).toContain("1 selected · 1 omitted");
    expect(withOmitted).toContain("42 estimated tokens");
    expect(withOmitted).toContain("Omitted sources");
    expect(withOmitted).toContain("outside recent-turn policy");
    expect(empty).toContain("hash abcdef123456");
    expect(empty).not.toContain("0 selected");
    expect(empty).not.toContain("0 omitted");
    expect(omittedOnly).toContain("1 omitted");
    expect(omittedOnly).not.toContain("0 selected");
  });

  it("keeps the Run summary free of duplicate state and count grammar", () => {
    const details = renderToStaticMarkup(<RunDetails run={run({
      status: "blocked", phase: "blocked", transcriptCount: 1,
      contract: {
        sourceInput: "Ship it", summary: "Ship it", acceptanceCriteria: ["Checks pass"],
        scope: "Repository", nonGoals: [], sourceInboxIds: [], parentRunId: null,
        relation: "independent", intent: "new_task", decisionReason: "Parsed 1 semantic objective(s) into a TaskRun contract.", routerVersion: "v1",
      },
    })} toolEvents={[]} transcriptTools={[]} />);
    const partialUsage = renderToStaticMarkup(<RunDetails run={run({
      status: "completed",
      phase: "done",
      completedAt: 20,
      usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    })} toolEvents={[]} transcriptTools={[]} />);
    const inputOnlyUsage = renderToStaticMarkup(<RunDetails run={run({
      status: "completed", phase: "done", completedAt: 20,
      usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    })} toolEvents={[]} transcriptTools={[]} />);

    expect(details).toContain('<div class="phase-line"><span class="status-label" data-tone="warning"><span class="status-dot"></span>Blocked</span></div>');
    expect(details).toContain("1 message");
    expect(details).not.toContain("1 messages");
    expect(details).not.toContain("Blocked</span><span>Blocked");
    expect(details).not.toContain("attempt 1");
    expect(details).toContain("Parsed 1 semantic objective into a TaskRun contract.");
    expect(details).not.toContain("objective(s)");
    expect(details).toContain(">pending<");
    expect(details).not.toContain("0 blockers");
    expect(partialUsage).toContain("5 in / 2 out");
    expect(partialUsage).not.toContain("0 tokens");
    expect(partialUsage).not.toContain("token usage is observational only");
    expect(inputOnlyUsage).toContain(">5 in<");
    expect(inputOnlyUsage).not.toContain("0 out");
  });

  it("renders operational sections only when they contain inspectable data", () => {
    const tool = {
      seq: 4, index: 0, attempt: 1, kind: "tool", toolCallId: "call-1", toolName: "bash",
      arguments: { command: "npm test" }, result: "passed", isError: false, status: "completed", createdAt: 4,
    } satisfies Extract<TranscriptItem, { kind: "tool" }>;
    const populated = renderToStaticMarkup(<RunDetails run={run({
      transcriptCount: 7,
      usage: { input: 120, output: 45, cacheRead: 0, cacheWrite: 0, totalTokens: 165, cost: 0 },
      plan: [{ key: "implement", title: "Implement the refinement", status: "done", required: true, position: 0 }],
      checks: [{
        key: "tests", title: "Run regression tests", status: "passed", required: true,
        command: "npm test", evidence: "passed", stale: false, sourceOperationId: "operation-1", observedAt: 4,
      }],
      continuations: [{
        id: "continuation-1", ordinal: 1, status: "completed", reason: "Verify the result", error: "",
        notBefore: 1, createdAt: 1, startedAt: 2, completedAt: 3,
        leaseOwner: "", leaseUntil: null, heartbeatAt: null,
      }],
      artifacts: [{ id: "artifact-1", title: "Verification report", kind: "markdown", uri: "artifact://report" }],
    })} toolEvents={[{
      runId: "run-1", seq: 4, type: "tool.completed",
      data: { toolCallId: "call-1", toolName: "bash" }, createdAt: 4,
    }]} transcriptTools={[tool]} />);
    const recentOnly = renderToStaticMarkup(<RunDetails run={run()} toolEvents={[{
      runId: "run-1", seq: 4, type: "tool.completed",
      data: { toolCallId: "call-1", toolName: "bash" }, createdAt: 4,
    }]} transcriptTools={[]} />);
    const planOnly = renderToStaticMarkup(<RunDetails run={run({
      plan: [{ key: "inspect", title: "Inspect the current interface", status: "in_progress", required: true, position: 0 }],
    })} toolEvents={[]} transcriptTools={[]} />);

    expect(populated).toContain(">Tool activity<");
    expect(populated).toContain("7 messages");
    expect(populated).toContain("165 tokens");
    expect(populated).toContain("120 in / 45 out");
    expect(populated).not.toContain("token usage is observational only");
    expect(populated).toContain("Recorded tool calls");
    expect(populated).toContain("1 call");
    expect(populated).toContain(">Execution evidence<");
    expect(populated).toContain('<span class="run-evidence-group-label" data-label="true"><span>Plan</span><small>1/1</small></span>');
    expect(populated).toContain('<span class="run-evidence-group-label" data-label="true"><span>Checks</span><small>1/1</small></span>');
    expect(populated).toContain('<span class="run-evidence-group-label" data-label="true"><span>Continuations</span><small>1</small></span>');
    expect(populated).toContain(">Plan<");
    expect(populated).toContain("Implement the refinement");
    expect(populated).toContain(">Checks<");
    expect(populated).toContain("Run regression tests");
    expect(populated).toContain(">Continuations<");
    expect(populated).toContain("Verify the result");
    expect(populated).toContain(">Artifacts<");
    expect(populated).toContain("Verification report");
    expect(recentOnly).toContain(">Tool activity<");
    expect(recentOnly).toContain("1 recent event");
    expect(recentOnly).not.toContain("0 calls");
    expect(planOnly).toContain(">Plan<");
    expect(planOnly).toContain("0/1 complete");
    expect(planOnly).not.toContain("Execution evidence");
    expect(planOnly).not.toContain("run-evidence-group-label");
  });
});
