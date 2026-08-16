import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SessionInputRouter,
  type SessionInputModelPort,
  type SessionInputModelUsage,
} from "@tagent/admission/composition";
import type { Message } from "@tagent/admission/domain";
import type { TaskRun } from "@tagent/execution/domain";

const active = { id: "run-1", goal: "发布 0.1.4", status: "running", phase: "implement" } as TaskRun;

function modelPort(
  request: (prompt: string) => Promise<unknown>,
  usage: SessionInputModelUsage[] = [],
): SessionInputModelPort {
  return {
    request: async (input) => ({
      value: await request(input.prompt),
      usage,
    }),
  };
}

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const filename = path.join(root, name);
    return statSync(filename).isDirectory()
      ? sourceFiles(filename)
      : filename.endsWith(".ts") ? [filename] : [];
  }).sort();
}

describe("Admission module boundary", () => {
  it("keeps Admission domain and application independent of transport, storage, Pi, and React", () => {
    const roots = [
      path.join(process.cwd(), "packages", "admission", "src", "domain"),
      path.join(process.cwd(), "packages", "admission", "src", "application"),
    ];
    const forbiddenImports = /(?:^|\/)(?:store\/store|persistence)(?:\.|\/)|^(?:fastify|better-sqlite3|react|react-dom|@earendil-works\/pi-)/;
    const violations = roots.flatMap(sourceFiles).flatMap((filename) => {
      const source = readFileSync(filename, "utf8");
      const imports = [...source.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g)].map((match) => match[2]);
      return imports.filter((specifier) => forbiddenImports.test(specifier)).map((specifier) => `${path.relative(process.cwd(), filename)} -> ${specifier}`);
    });
    expect(violations).toEqual([]);
  });
});

describe("SessionInputRouter", async () => {
  const router = new SessionInputRouter();
  it("routes corrections and safety constraints to the active Run", async () => {
    expect(await router.analyze("不要重启服务，端口改成 3220", active)).toMatchObject({ intent: "steer_active", targetRunId: "run-1", relation: "correction", priority: 900 });
  });
  it("routes parameters as active context updates", async () => {
    expect(await router.analyze("补充：代码路径在 /opt/tagent-core", active)).toMatchObject({ intent: "update_active_context", targetRunId: "run-1", relation: "same_goal" });
  });
  it("routes explicit post-completion work as follow-up", async () => {
    expect(await router.analyze("完成后再补一份部署文档", active)).toMatchObject({ intent: "follow_up_active", targetRunId: "run-1", relation: "follow_up" });
  });
  it("creates a parallel proposal only for explicit independent parallel work", async () => {
    expect(await router.analyze("同时并行设计另一个独立的移动端客户端", active)).toMatchObject({ intent: "parallel_task", targetRunId: "run-1", relation: "parallel" });
  });
  it("does not mistake a discourse marker for independent parallel work", async () => {
    const result = await router.analyze("看看为什么需要三次 attempt。另外你可以重启 3220，不会影响自己。", undefined);
    expect(result.objectives).toHaveLength(2);
    expect(result.objectives.every((item) => item.timing === "current")).toBe(true);
    expect(result.intent).toBe("new_task");
  });
  it("classifies lightweight discussion and clarification turns", async () => {
    expect(await router.analyze("为什么需要 completion gate？")).toMatchObject({ intent: "discussion", priority: 350 });
    expect(await router.analyze("刚才具体哪个路径错了？")).toMatchObject({ intent: "clarification", priority: 350 });
  });
  it("classifies non-programming deliveries by execution rather than topic keywords", async () => {
    const translation = await router.analyze("把下面这句话翻译成英文：我们明天见。");
    const proofreading = await router.analyze("检查这句话有没有语病。");
    const releaseExplanation = await router.analyze("介绍一下安全发布流程。");
    expect([translation, proofreading, releaseExplanation].map((item) => item.executionPolicy)).toEqual([
      expect.objectContaining({ mode: "semantic_delivery", reviewPolicy: "semantic_lite", evidencePolicy: "semantic" }),
      expect.objectContaining({ mode: "semantic_delivery", reviewPolicy: "semantic_lite", evidencePolicy: "semantic" }),
      expect.objectContaining({ mode: "semantic_delivery", reviewPolicy: "semantic_lite", evidencePolicy: "semantic" }),
    ]);
  });
  it("uses local review only for a literal response", async () => {
    expect((await router.analyze("只回复 OK。")).executionPolicy).toMatchObject({ mode: "exact_delivery", reviewPolicy: "local", exactOutput: "OK" });
    expect((await router.analyze("解释 OK 的含义。")).executionPolicy).toMatchObject({ mode: "semantic_delivery", reviewPolicy: "semantic_lite" });
  });
  it("fails closed for an unresolved imperative when no semantic Router model is configured", async () => {
    const result = await router.analyze("执行这个方案");
    expect(result.executionPolicy).toMatchObject({ mode: "external_action", sideEffectRisk: "external_high", policyVersion: "task-policy-conservative-fallback-v1" });
    expect(result.reason).toContain("Semantic routing unavailable");
  });
  it("uses the LLM to distinguish discussing a risky action from executing it", async () => {
    let calls = 0;
    const router = new SessionInputRouter({ model: modelPort(async () => {
      calls += 1;
      return {
        summary: "解释生产部署流程", objectives: [{ summary: "解释如何部署到生产环境", timing: "current", kind: "answer" }],
        intent: "discussion", targetActiveRun: false, priority: 350, urgency: "normal", relation: "independent",
        acceptanceCriteria: ["清楚解释部署流程"], scope: "流程说明", nonGoals: ["不执行部署"], confidence: .98,
        reason: "用户要求解释流程，不是执行部署",
        executionPolicy: { mode: "semantic_delivery", sideEffectRisk: "none", evidencePolicy: "semantic", reviewPolicy: "semantic_lite", confidence: .98, reason: "The operation is only the subject of an explanation." },
      };
    }) });
    expect((await router.analyze("解释如何部署到生产环境。")).executionPolicy).toMatchObject({ mode: "semantic_delivery", sideEffectRisk: "none", evidencePolicy: "semantic", reviewPolicy: "semantic_lite" });
    expect(calls).toBe(1);
    expect((await router.analyze("请部署到生产环境。")).executionPolicy).toMatchObject({ mode: "external_action", reviewPolicy: "full", evidencePolicy: "trusted_check" });
    expect(calls).toBe(1);
  });
  it("classifies source-control publication and hot activation as external actions", async () => {
    for (const request of ["提交并推送，然后执行热更新", "激活暂存发布"]) {
      expect((await router.analyze(request)).executionPolicy).toMatchObject({
        mode: "external_action",
        sideEffectRisk: "external_high",
        reviewPolicy: "full",
      });
    }
  });
  it("does not treat hot-update architecture review as executing a hot update", async () => {
    expect((await router.analyze("审查并评估热更新和自恢复架构当前设计和实现")).executionPolicy).toMatchObject({
      mode: "read_only_analysis",
      sideEffectRisk: "read_only",
    });
  });
  it("routes external-action synonyms through semantic classification and preserves the safety floor", async () => {
    const phrases = ["把最新版同步到线上", "把这个结果通知客户", "清空远端缓存", "给 Alice 开管理员权限", "合并并推到主分支", "把最新构建交付到客户环境", "撤掉线上旧实例", "将账号设为管理员", "把报告发给客户", "删除远端资源", "忘记关于 Alice 的长期记忆", "删除这些记忆记录", "forget these memory records"];
    let calls = 0;
    const semantic = new SessionInputRouter({ model: modelPort(async (prompt) => {
      calls += 1;
      const input = JSON.parse(prompt.split("INPUT_DATA=")[1]!) as { userInput: string };
      return { summary: input.userInput, objectives: [{ summary: input.userInput, timing: "current", kind: "change" }], intent: "new_task", targetActiveRun: false, priority: 700, urgency: "normal", relation: "independent", acceptanceCriteria: ["完成外部动作"], scope: "external", nonGoals: [], confidence: .9, reason: "external imperative", executionPolicy: { mode: "external_action", sideEffectRisk: "external_high", evidencePolicy: "trusted_check", reviewPolicy: "full", confidence: .9, reason: "external effect" } };
    }) });
    for (const phrase of phrases) expect((await semantic.analyze(phrase)).executionPolicy).toMatchObject({ mode: "external_action", reviewPolicy: "full" });
    expect(calls).toBe(phrases.length);
  });
  it("uses semantic routing to distinguish explaining memory deletion from executing it", async () => {
    let calls = 0;
    const semantic = new SessionInputRouter({ model: modelPort(async () => {
      calls += 1;
      return {
        summary: "解释长期记忆删除机制", objectives: [{ summary: "解释如何删除长期记忆", timing: "current", kind: "answer" }],
        intent: "discussion", targetActiveRun: false, priority: 350, urgency: "normal", relation: "independent",
        acceptanceCriteria: ["解释删除机制"], scope: "机制说明", nonGoals: ["不删除记忆"], confidence: .98,
        reason: "用户要求解释机制而非执行删除",
        executionPolicy: { mode: "semantic_delivery", sideEffectRisk: "none", evidencePolicy: "semantic", reviewPolicy: "semantic_lite", confidence: .98, reason: "Explanation only." },
      };
    }) });
    expect((await semantic.analyze("解释如何删除长期记忆。")).executionPolicy).toMatchObject({ mode: "semantic_delivery", reviewPolicy: "semantic_lite" });
    expect(calls).toBe(1);
  });
  it("normalizes an internally inconsistent LLM policy without discarding the semantic contract", async () => {
    const router = new SessionInputRouter({ model: modelPort(async () => ({
      summary: "解释生产部署流程", objectives: [{ summary: "解释如何部署到生产环境", timing: "current", kind: "answer" }],
      intent: "discussion", targetActiveRun: false, priority: 350, urgency: "normal", relation: "independent",
      acceptanceCriteria: ["清楚解释部署流程"], scope: "流程说明", nonGoals: ["不执行部署"], confidence: .98, reason: "answer",
      executionPolicy: { mode: "semantic_delivery", sideEffectRisk: "external_high", evidencePolicy: "trusted_check", reviewPolicy: "full", confidence: .98, reason: "inconsistent" },
    })) });
    const result = await router.analyze("结合以上说明解释如何部署到生产环境。");
    expect(result).toMatchObject({
      routerVersion: "llm-semantic-v1",
      summary: "解释生产部署流程",
      intent: "discussion",
      executionPolicy: { mode: "external_action", sideEffectRisk: "external_high", evidencePolicy: "trusted_check", reviewPolicy: "full" },
    });
    expect(result.executionPolicy?.reason).toContain("Core normalized an inconsistent execution-policy profile");
    expect(result.reason).not.toContain("Semantic routing unavailable");
  });
  it("preserves an open-ended research contract when redundant policy fields disagree", async () => {
    const router = new SessionInputRouter({ model: modelPort(async () => ({
      summary: "研究公开社区中的真实用户痛点并交付多文件分析",
      objectives: [{ summary: "收集原始发言、聚类痛点并在样本达标后反推 ICP", timing: "current", kind: "investigate" }],
      intent: "new_task", targetActiveRun: false, priority: 500, urgency: "normal", relation: "independent",
      acceptanceCriteria: [
        "交付 raw_findings.csv、pain_clusters.md、icp_candidates.md、communities.md 和 surprises.md",
        "raw_findings.csv 包含 150–300 条可追溯记录并覆盖指定社区",
      ],
      scope: "公开的一手用户表达", nonGoals: ["不进行跨平台身份关联"], confidence: .94, reason: "open research",
      executionPolicy: { mode: "read_only_analysis", sideEffectRisk: "none", evidencePolicy: "operation_receipt", reviewPolicy: "full", confidence: .91, reason: "research from public evidence" },
    })) });
    const result = await router.analyze("结合以上约束，完成一项开放式社区研究，先宽泛收集可追溯原始记录，再聚类痛点，在样本达到至少 150 条后反推 ICP，最后独立检索反证，并交付五个指定文件。");
    expect(result).toMatchObject({
      routerVersion: "llm-semantic-v1",
      executionPolicy: { mode: "read_only_analysis", sideEffectRisk: "read_only", evidencePolicy: "operation_receipt", reviewPolicy: "full" },
      acceptanceCriteria: [
        "交付 raw_findings.csv、pain_clusters.md、icp_candidates.md、communities.md 和 surprises.md",
        "raw_findings.csv 包含 150–300 条可追溯记录并覆盖指定社区",
      ],
    });
    expect(result.reason).not.toContain("Semantic routing unavailable");
  });
  it("does not turn local research-file delivery into an external action when semantic routing is unavailable", async () => {
    const router = new SessionInputRouter({ model: modelPort(async () => { throw new Error("provider unavailable"); }) });
    const result = await router.analyze("交付 raw_findings.csv、pain_clusters.md、icp_candidates.md、communities.md 和 surprises.md 五个文件，并基于公开社区完成研究。");
    expect(result.executionPolicy).toMatchObject({ mode: "read_only_analysis", sideEffectRisk: "read_only" });
    expect(result.executionPolicy?.mode).not.toBe("external_action");
    expect(result.reason).toContain("Semantic routing unavailable; deterministic fallback used: provider unavailable");
  });
  it("rejects model-proposed exact validation without an explicit literal request", async () => {
    const router = new SessionInputRouter({ model: modelPort(async () => ({
      summary: "解释 OK", objectives: [{ summary: "解释 OK 的含义", timing: "current", kind: "answer" }],
      intent: "discussion", targetActiveRun: false, priority: 350, urgency: "normal", relation: "independent",
      acceptanceCriteria: ["解释 OK 的含义"], scope: "普通解释", nonGoals: [], confidence: .96, reason: "answer",
      executionPolicy: { mode: "exact_delivery", sideEffectRisk: "none", evidencePolicy: "none", reviewPolicy: "local", exactOutput: "OK", confidence: .9, reason: "incorrect literal proposal" },
    })) });
    expect((await router.analyze("结合以上说明解释 OK 的含义。")).executionPolicy).toMatchObject({ mode: "semantic_delivery", reviewPolicy: "semantic_lite", exactOutput: undefined });
  });
  it("preserves the strongest risk implication when rejecting an invalid exact-delivery proposal", async () => {
    const router = new SessionInputRouter({ model: modelPort(async () => ({
      summary: "解释部署流程", objectives: [{ summary: "解释部署流程", timing: "current", kind: "answer" }],
      intent: "discussion", targetActiveRun: false, priority: 350, urgency: "normal", relation: "independent",
      acceptanceCriteria: ["解释部署流程"], scope: "流程说明", nonGoals: ["不部署"], confidence: .96, reason: "answer",
      executionPolicy: { mode: "exact_delivery", sideEffectRisk: "external_high", evidencePolicy: "trusted_check", reviewPolicy: "full", exactOutput: "OK", confidence: .9, reason: "inconsistent exact proposal" },
    })) });
    expect((await router.analyze("结合以上说明解释部署到生产环境的流程。")).executionPolicy).toMatchObject({ mode: "external_action", sideEffectRisk: "external_high", reviewPolicy: "full", exactOutput: undefined });
  });
  it("persists explicit postponement as deferred work", async () => {
    expect(await router.analyze("暂时不做")).toMatchObject({ intent: "defer", priority: 100, acceptanceCriteria: [] });
  });
  it("summarizes new tasks instead of using the full raw prompt as their goal", async () => {
    const result = await router.analyze("请审计当前 Supervisor 的实现差异。然后给出可验证的建议。", undefined);
    expect(result.intent).toBe("new_task");
    expect(result.summary).toContain("审计当前 Supervisor 的实现差异");
    expect(result.objectives.map((item) => item.summary)).toEqual(["审计当前 Supervisor 的实现差异", "给出可验证的建议"]);
    expect(result.acceptanceCriteria.length).toBeGreaterThanOrEqual(3);
  });
});

describe("SessionInputRouter LLM parsing", () => {
  it("uses the LLM semantic contract instead of punctuation rules", async () => {
    const router = new SessionInputRouter({ model: modelPort(async () => ({
      summary: "将 SessionInputRouter 改为 LLM 任务解析",
      objectives: [{ summary: "实现 LLM 任务解析并保留可靠回退", timing: "current", kind: "change" }],
      intent: "new_task", targetActiveRun: false, priority: 600, urgency: "normal", relation: "independent",
      acceptanceCriteria: ["Router 使用 LLM 输出结构化任务合同", "LLM 不可用时可可靠回退"], scope: "SessionInputRouter 任务解析", nonGoals: ["不执行在线强化学习"], confidence: 0.96, reason: "用户请求的是一个实现目标，不是两个按标点拆分的目标",
    })) });
    const result = await router.analyze("SessionInputRouter不是llm拆解下发任务吗？改成llm的任务解析");
    expect(result).toMatchObject({ routerVersion: "llm-semantic-v1", summary: "将 SessionInputRouter 改为 LLM 任务解析", intent: "new_task" });
    expect(result.objectives).toHaveLength(1);
  });

  it("falls back deterministically when the LLM request fails", async () => {
    const router = new SessionInputRouter({ model: modelPort(async () => { throw new Error("provider unavailable"); }) });
    const result = await router.analyze("结合上面的运行记录，分析并修复 Router 在当前 active Run 路由中的歧义问题，同时验证长文本和多目标输入仍可可靠解析");
    expect(result.routerVersion).toBe("semantic-rules-v3");
    expect(result.reason).toContain("deterministic fallback used");
  });

  it("rejects an active-run route when no active Run exists", async () => {
    const router = new SessionInputRouter({ model: modelPort(async () => ({ summary: "steer", objectives: [{ summary: "stop", timing: "current", kind: "change" }], intent: "steer_active", targetActiveRun: true, priority: 900, urgency: "normal", relation: "correction", acceptanceCriteria: ["stop"], scope: "run", nonGoals: [], confidence: 1, reason: "steer" })) });
    const result = await router.analyze("stop");
    expect(result.routerVersion).toBe("semantic-rules-v3");
  });
});

describe("SessionInputRouter background filtering", () => {
  it("instructs the LLM to keep specification background out of task objectives", async () => {
    let prompt = "";
    const router = new SessionInputRouter({ model: modelPort(async (value) => {
      prompt = value;
      return {
        summary: "评估持续进化方案并制定开发计划",
        objectives: [{ summary: "基于当前代码评估方案并制定开发完善计划", timing: "current", kind: "investigate" }],
        intent: "new_task", targetActiveRun: false, priority: 600, urgency: "normal", relation: "independent",
        acceptanceCriteria: ["给出代码现状证据、合理性判断和分阶段开发计划"], scope: "方案评估与开发规划", nonGoals: [], confidence: 0.98,
        reason: "其余架构、阶段和指标列表是待评估的背景材料，不是独立任务",
      };
    }) });
    const result = await router.analyze("请根据当前代码评估以下方案并制定计划。背景：Observe -> Attribute。Phase 0：定义指标。Phase 1：实现 Profile。验收：覆盖率 95%。");
    expect(prompt).toContain("Background can inform a task but MUST NOT become its own objective");
    expect(prompt).toContain("not one objective per heading, bullet, sentence, phase, or punctuation mark");
    expect(result.objectives).toEqual([expect.objectContaining({ summary: "基于当前代码评估方案并制定开发完善计划" })]);
    expect(result.acceptanceCriteria).toHaveLength(1);
  });


  it("includes bounded Session and recent TaskRun context for reference resolution", async () => {
    let prompt = "";
    const router = new SessionInputRouter({ model: modelPort(async (value) => {
      prompt = value;
      return {
        summary: "按上一轮方案优化 Router", objectives: [{ summary: "按上一轮性能方案优化 Router", timing: "current", kind: "change" }],
        intent: "new_task", targetActiveRun: false, priority: 600, urgency: "normal", relation: "independent",
        acceptanceCriteria: ["Router 优化采用上一轮已确认的上下文"], scope: "Router 优化", nonGoals: [], confidence: 0.96,
        reason: "当前输入引用了最近对话中的 Router 性能方案",
      };
    }) });
    const oldMessages = Array.from({ length: 14 }, (_, index) => ({ id: index + 1, sessionId: "session-1", role: index % 2 ? "assistant" : "user", content: `history-${index + 1}`, createdAt: index + 1 })) as Message[];
    const recentRun = { ...active, id: "run-old", goal: "优化执行性能", status: "completed", updatedAt: 123, contract: { summary: "优化 Router 和 Supervisor 延迟", objectives: [{ id: "objective-1", summary: "优化 Router 延迟", timing: "current", kind: "change" }] } } as TaskRun;
    await router.analyze("根据以上内容优化完善", undefined, { recentMessages: oldMessages, recentRuns: [recentRun] });
    expect(prompt).toContain('"sessionContext"');
    expect(prompt).toContain("history-14");
    expect(prompt).not.toContain('"content":"history-1"');
    expect(prompt).toContain("优化 Router 和 Supervisor 延迟");
    expect(prompt).toContain("Recent assistant messages are context, not user requests");
  });

  it("uses different Session context to resolve the same reference into different routing results", async () => {
    const router = new SessionInputRouter({ model: modelPort(async (prompt) => {
      const isRouterPlan = prompt.includes("采用批处理降低 Router 延迟");
      const resolved = isRouterPlan ? "采用批处理降低 Router 延迟" : "为 Supervisor 增加并行审查";
      return {
        summary: `按已确认方案继续：${resolved}`,
        objectives: [{ summary: resolved, timing: "current", kind: "change" }],
        intent: "new_task", targetActiveRun: false, priority: 600, urgency: "normal", relation: "same_goal",
        acceptanceCriteria: [`实现已确认方案：${resolved}`], scope: resolved, nonGoals: [], confidence: 0.99,
        reason: `通过 Session context 将“按刚才方案继续”解析为：${resolved}`,
      };
    }) });
    const message = (content: string) => [{ id: 1, sessionId: "session-1", role: "assistant", content, createdAt: 1 }] as Message[];

    const routerResult = await router.analyze("按刚才方案继续", undefined, { recentMessages: message("已确认方案：采用批处理降低 Router 延迟") });
    const supervisorResult = await router.analyze("按刚才方案继续", undefined, { recentMessages: message("已确认方案：为 Supervisor 增加并行审查") });

    expect(routerResult.objectives[0]?.summary).toBe("采用批处理降低 Router 延迟");
    expect(supervisorResult.objectives[0]?.summary).toBe("为 Supervisor 增加并行审查");
    expect(routerResult.summary).not.toBe(supervisorResult.summary);
    expect(routerResult.reason).toContain("Session context");
    expect(supervisorResult.reason).toContain("Session context");
  });

  it("allows background-only information to update an active Run without inventing tasks", async () => {
    const router = new SessionInputRouter({ model: modelPort(async () => ({
      summary: "补充 3220 对应 /opt/tagent-core 的运行背景", objectives: [], intent: "update_active_context", targetActiveRun: true,
      priority: 850, urgency: "normal", relation: "same_goal", acceptanceCriteria: [], scope: "活动任务运行环境背景", nonGoals: [], confidence: 0.99,
      reason: "用户只补充环境映射，没有要求新增工作",
    })) });
    const result = await router.analyze("背景信息：/opt/tagent-core 对应 3220，/root/tagent/tagent-core 对应 3210。", active);
    expect(result).toMatchObject({ intent: "update_active_context", targetRunId: "run-1", objectives: [], acceptanceCriteria: [], routerVersion: "llm-semantic-v1" });
  });

  it("captures model identity and usage through the provider-neutral port", async () => {
    const router = new SessionInputRouter({
      model: modelPort(async () => ({
        summary: "分析复杂任务",
        objectives: [{ summary: "分析复杂任务", timing: "current", kind: "investigate" }],
        intent: "new_task", targetActiveRun: false, priority: 600, urgency: "normal", relation: "independent",
        acceptanceCriteria: ["给出分析结果"], scope: "复杂任务", nonGoals: [], confidence: 0.96, reason: "semantic model result",
      }), [{ model: "router-model", input: 12, output: 8, cacheRead: 2, cacheWrite: 0, totalTokens: 20 }]),
    });
    const result = await router.analyze("结合现有上下文，详细分析这个跨模块复杂任务并给出完整结论。".repeat(12));
    expect(router.takeUsage(result)).toEqual([{
      model: "router-model",
      usage: { input: 12, output: 8, cacheRead: 2, cacheWrite: 0, totalTokens: 20 },
    }]);
    expect(router.takeUsage(result)).toEqual([]);
  });
});
