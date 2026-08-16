import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createCoreApplicationCoordinator,
  CoreWorkflowGovernanceApplication,
  type CoreApplicationServices,
} from "@tagent/core-service/application";
import {
  CanaryGovernanceRuntime,
  LearningBackgroundRuntimeCoordinator,
} from "@tagent/core-service/composition";
import type { CanaryGovernanceWorker } from "@tagent/governance/application";
import type { WorkflowGovernanceApplication } from "@tagent/governance/application";
import type { WorkflowGovernanceReaderRepository } from "@tagent/governance/ports";
import type { LearningFeatureControl } from "@tagent/learning";

const repoRoot = process.cwd();

function applicationServices(overrides: Partial<Record<keyof CoreApplicationServices, object>> = {}) {
  const group = (implementation: object = {}) => new Proxy(implementation, {
    get: (target, property) => Reflect.has(target, property) ? Reflect.get(target, property) : vi.fn(),
  });
  return {
    admission: group(overrides.admission),
    execution: group(overrides.execution),
    governance: group(overrides.governance),
    learning: group(overrides.learning),
    workspaceGoals: group(overrides.workspaceGoals),
    skills: group(overrides.skills),
  } as unknown as CoreApplicationServices;
}

describe("Core workflow Governance delegation", () => {
  it("binds every governance effect to the governance application", () => {
    const effects = [
      "activateWorkflow",
      "suspendWorkflow",
      "rollbackWorkflow",
      "forgetWorkflow",
      "restoreWorkflow",
      "applyWorkflowProposal",
      "promoteWorkflow",
      "executeAutonomyApproval",
      "updateLearningSettings",
    ];
    const calls = Object.fromEntries(effects.map((method) => [method, vi.fn(() => method)]));
    const coordinator = createCoreApplicationCoordinator(applicationServices({ governance: calls }));
    for (const effect of effects) expect((coordinator as unknown as Record<string, () => unknown>)[effect]()).toBe(effect);
  });

  it("preserves the rollback approvalId through the Core coordinator", () => {
    const rollbackWorkflow = vi.fn(() => "rolled-back");
    const coordinator = createCoreApplicationCoordinator(applicationServices({ governance: { rollbackWorkflow } }));

    expect(coordinator.rollbackWorkflow("workflow-1", "revision-1", "approval-1"))
      .toBe("rolled-back");
    expect(rollbackWorkflow).toHaveBeenCalledWith(
      "workflow-1",
      "revision-1",
      "approval-1",
    );
  });

  it("dispatches generic execution only from a matching neutral approval view", () => {
    const approval = {
      ref: { source: "workflow" as const, id: "approval-1" },
      action: "workflow.activate" as const,
      status: "approved" as const,
      expiresAt: Date.now() + 60_000,
      target: { kind: "workflow_revision", id: "revision-1" },
      workflowId: "workflow-1",
      revisionId: "revision-1",
      proposalId: null,
      scope: { type: "workflow_scope", id: "scope-1" },
      operationDigest: "digest-1",
      risk: "low" as const,
      reuse: { mode: "one_time" as const, maxUses: 1, usedCount: 0 },
      decidedBy: "governor",
      impactJson: "{}",
      execution: null,
    };
    const activate = vi.fn((command: { commandId: string }) => ({
      commandId: command.commandId,
      state: null,
      receipts: {},
      value: "activated",
    }));
    const reader = {
      getExecutableApproval: vi.fn(() => approval),
    } as unknown as WorkflowGovernanceReaderRepository;
    const application = new CoreWorkflowGovernanceApplication(
      { activate } as unknown as WorkflowGovernanceApplication,
      reader,
    );

    expect(application.executeAutonomyApproval("approval-1", "operator"))
      .toEqual({ approval, result: "activated" });
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: "workflow-1",
      revisionId: "revision-1",
      scopeId: "scope-1",
      actorId: "operator",
      approval: expect.objectContaining({
        action: "workflow.activate",
        operationDigest: "digest-1",
      }),
    }));
  });

  it("commits normalized feature policy before refreshing read-only Learning state", async () => {
    const order: string[] = [];
    const updateFeaturePolicy = vi.fn(() => {
      order.push("commit");
      return {};
    });
    const state = {
      memoryAvailable: true,
      memoryEnabled: true,
      learningEnabled: false,
      autoExecutionEnabled: false,
      passiveLearningEnabled: false,
      activeExecutionRequiresApproval: true as const,
      updatedAt: 10,
      reason: "before",
    };
    const learningControl = {
      snapshot: () => state,
      refresh: async () => {
        order.push("refresh");
        return { ...state, learningEnabled: true, autoExecutionEnabled: true };
      },
    } as unknown as LearningFeatureControl;
    const application = new CoreWorkflowGovernanceApplication(
      { updateFeaturePolicy } as unknown as WorkflowGovernanceApplication,
      {} as WorkflowGovernanceReaderRepository,
      learningControl,
    );

    await expect(application.updateLearningSettings({
      learningEnabled: true,
      autoExecutionEnabled: true,
      reason: "admin",
    })).resolves.toMatchObject({ learningEnabled: true, autoExecutionEnabled: true });
    expect(order).toEqual(["commit", "refresh"]);
    expect(updateFeaturePolicy).toHaveBeenCalledWith(expect.objectContaining({
      target: { kind: "global" },
      reason: "admin",
      policy: {
        memoryEnabled: true,
        learningEnabled: true,
        autoExecutionEnabled: true,
      },
    }));
  });

  it("assembles the Governance application and independent canary polling runtime", () => {
    const server = readFileSync(path.join(repoRoot, "apps/core-service/src/server.ts"), "utf8");
    const composition = readFileSync(
      path.join(repoRoot, "apps/core-service/src/composition/execution-composition.ts"),
      "utf8",
    );
    expect(composition).toContain("new WorkflowGovernanceApplication(");
    expect(composition).toContain("new LearningWorkflowRevisionMaterializer()");
    expect(composition).toContain("options.persistence.workflowGovernance");
    expect(server).toContain("new CanaryGovernanceWorker(");
    expect(server).toContain("new CanaryGovernanceRuntime(");
    expect(server).toContain("persistence.workflowGovernance");
    expect(server.indexOf("await canaryGovernanceRuntime?.close()"))
      .toBeLessThan(server.indexOf("await distillationWorker?.close()"));
    expect(server.match(/startCanaryGovernance/g)).toBeNull();
  });

  it("starts with durable recovery, keeps polling single-flight, and converges rapid toggles", async () => {
    let releaseRun!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseRun = resolve; });
    const runOnce = vi.fn(async () => {
      await blocked;
      return { kind: "idle", reason: "no_candidate" as const };
    });
    const runtime = new CanaryGovernanceRuntime(
      { runOnce } as unknown as CanaryGovernanceWorker,
      { intervalMs: 60_000 },
    );
    runtime.start();
    const first = runtime.runOnce();
    const second = runtime.runOnce();
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledTimes(1));
    expect(first).toBe(second);
    releaseRun();
    await first;
    await runtime.stop();

    let releaseStop!: () => void;
    const stopBlocked = new Promise<void>((resolve) => { releaseStop = resolve; });
    const starts = new Map<string, number>();
    const stops = new Map<string, number>();
    const unit = (name: string, blockStop = false) => ({
      name,
      start: () => { starts.set(name, (starts.get(name) ?? 0) + 1); },
      stop: async () => {
        stops.set(name, (stops.get(name) ?? 0) + 1);
        if (blockStop) await stopBlocked;
      },
    });
    const projection = unit("projection");
    const distillation = unit("distillation");
    const canary = unit("canary", true);
    const coordinator = new LearningBackgroundRuntimeCoordinator(
      [projection, distillation, canary],
      [canary, projection, distillation],
    );
    await coordinator.reconcile(true);
    const disable = coordinator.reconcile(false);
    await vi.waitFor(() => expect(stops.get("canary")).toBe(1));
    const enable = coordinator.reconcile(true);
    releaseStop();
    await Promise.all([disable, enable]);

    expect(starts).toEqual(new Map([
      ["projection", 1],
      ["distillation", 1],
      ["canary", 2],
    ]));
    expect(stops).toEqual(new Map([["canary", 1]]));
    await coordinator.close();
  });
});
