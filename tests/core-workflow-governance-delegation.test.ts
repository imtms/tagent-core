import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  CoreApplicationCoordinator,
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

function parsedSource(relativePath: string) {
  return ts.createSourceFile(
    relativePath,
    readFileSync(path.join(repoRoot, relativePath), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function methodReceiver(source: ts.SourceFile, methodName: string): string | undefined {
  let receiver: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === methodName) {
      const call = node.body?.statements
        .filter(ts.isReturnStatement)
        .map((statement) => statement.expression)
        .find((node): node is ts.CallExpression => node !== undefined && ts.isCallExpression(node));
      if (call && ts.isPropertyAccessExpression(call.expression)) {
        receiver = call.expression.expression.getText(source);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return receiver;
}

describe("Core workflow Governance delegation", () => {
  it("routes every compatibility effect through services.governance", () => {
    const source = parsedSource("apps/core-service/src/application/core-application-coordinator.ts");
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
    expect(Object.fromEntries(effects.map((method) => [method, methodReceiver(source, method)])))
      .toEqual(Object.fromEntries(effects.map((method) => [method, "this.services.governance"])));
  });

  it("preserves the rollback approvalId through the compatibility coordinator", () => {
    const rollbackWorkflow = vi.fn(() => "rolled-back");
    const coordinator = new CoreApplicationCoordinator({
      governance: { rollbackWorkflow },
    } as unknown as CoreApplicationServices);

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
      ref: { source: "legacy_workflow" as const, id: "approval-1" },
      action: "workflow.activate" as const,
      status: "approved" as const,
      expiresAt: Date.now() + 60_000,
      target: { kind: "workflow_revision", id: "revision-1" },
      workflowId: "workflow-1",
      revisionId: "revision-1",
      proposalId: null,
      scope: { type: "legacy_workflow_scope", id: "scope-1" },
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
