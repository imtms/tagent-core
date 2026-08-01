import { describe, expect, it } from "vitest";
import { SessionInputRouter } from "../src/core/session-input-router.js";
import type { TaskRun } from "../src/core/types.js";

const active = { id: "run-1", goal: "发布 0.1.4", status: "running", phase: "implement" } as TaskRun;

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
    const router = new SessionInputRouter({ request: async () => ({
      summary: "将 SessionInputRouter 改为 LLM 任务解析",
      objectives: [{ summary: "实现 LLM 任务解析并保留可靠回退", timing: "current", kind: "change" }],
      intent: "new_task", targetActiveRun: false, priority: 600, urgency: "normal", relation: "independent",
      acceptanceCriteria: ["Router 使用 LLM 输出结构化任务合同", "LLM 不可用时可可靠回退"], scope: "SessionInputRouter 任务解析", nonGoals: ["不执行在线强化学习"], confidence: 0.96, reason: "用户请求的是一个实现目标，不是两个按标点拆分的目标",
    }) });
    const result = await router.analyze("SessionInputRouter不是llm拆解下发任务吗？改成llm的任务解析");
    expect(result).toMatchObject({ routerVersion: "llm-semantic-v1", summary: "将 SessionInputRouter 改为 LLM 任务解析", intent: "new_task" });
    expect(result.objectives).toHaveLength(1);
  });

  it("falls back deterministically when the LLM request fails", async () => {
    const router = new SessionInputRouter({ request: async () => { throw new Error("provider unavailable"); } });
    const result = await router.analyze("修复 Router");
    expect(result.routerVersion).toBe("semantic-rules-v3");
    expect(result.reason).toContain("deterministic fallback used");
  });

  it("rejects an active-run route when no active Run exists", async () => {
    const router = new SessionInputRouter({ request: async () => ({ summary: "steer", objectives: [{ summary: "stop", timing: "current", kind: "change" }], intent: "steer_active", targetActiveRun: true, priority: 900, urgency: "normal", relation: "correction", acceptanceCriteria: ["stop"], scope: "run", nonGoals: [], confidence: 1, reason: "steer" }) });
    const result = await router.analyze("stop");
    expect(result.routerVersion).toBe("semantic-rules-v3");
  });
});

describe("SessionInputRouter background filtering", () => {
  it("instructs the LLM to keep specification background out of task objectives", async () => {
    let prompt = "";
    const router = new SessionInputRouter({ request: async (value) => {
      prompt = value;
      return {
        summary: "评估持续进化方案并制定开发计划",
        objectives: [{ summary: "基于当前代码评估方案并制定开发完善计划", timing: "current", kind: "investigate" }],
        intent: "new_task", targetActiveRun: false, priority: 600, urgency: "normal", relation: "independent",
        acceptanceCriteria: ["给出代码现状证据、合理性判断和分阶段开发计划"], scope: "方案评估与开发规划", nonGoals: [], confidence: 0.98,
        reason: "其余架构、阶段和指标列表是待评估的背景材料，不是独立任务",
      };
    } });
    const result = await router.analyze("请根据当前代码评估以下方案并制定计划。背景：Observe -> Attribute。Phase 0：定义指标。Phase 1：实现 Profile。验收：覆盖率 95%。");
    expect(prompt).toContain("Background can inform a task but MUST NOT become its own objective");
    expect(prompt).toContain("not one objective per heading, bullet, sentence, phase, or punctuation mark");
    expect(result.objectives).toEqual([expect.objectContaining({ summary: "基于当前代码评估方案并制定开发完善计划" })]);
    expect(result.acceptanceCriteria).toHaveLength(1);
  });


  it("includes bounded Session and recent TaskRun context for reference resolution", async () => {
    let prompt = "";
    const router = new SessionInputRouter({ request: async (value) => {
      prompt = value;
      return {
        summary: "按上一轮方案优化 Router", objectives: [{ summary: "按上一轮性能方案优化 Router", timing: "current", kind: "change" }],
        intent: "new_task", targetActiveRun: false, priority: 600, urgency: "normal", relation: "independent",
        acceptanceCriteria: ["Router 优化采用上一轮已确认的上下文"], scope: "Router 优化", nonGoals: [], confidence: 0.96,
        reason: "当前输入引用了最近对话中的 Router 性能方案",
      };
    } });
    const oldMessages = Array.from({ length: 14 }, (_, index) => ({ id: index + 1, sessionId: "session-1", role: index % 2 ? "assistant" : "user", content: `history-${index + 1}`, createdAt: index + 1 })) as import("../src/core/types.js").Message[];
    const recentRun = { ...active, id: "run-old", goal: "优化执行性能", status: "completed", updatedAt: 123, contract: { summary: "优化 Router 和 Supervisor 延迟", objectives: [{ id: "objective-1", summary: "优化 Router 延迟", timing: "current", kind: "change" }] } } as TaskRun;
    await router.analyze("根据以上内容优化完善", undefined, { recentMessages: oldMessages, recentRuns: [recentRun] });
    expect(prompt).toContain('"sessionContext"');
    expect(prompt).toContain("history-14");
    expect(prompt).not.toContain('"content":"history-1"');
    expect(prompt).toContain("优化 Router 和 Supervisor 延迟");
    expect(prompt).toContain("Recent assistant messages are context, not user requests");
  });

  it("uses different Session context to resolve the same reference into different routing results", async () => {
    const router = new SessionInputRouter({ request: async (prompt) => {
      const isRouterPlan = prompt.includes("采用批处理降低 Router 延迟");
      const resolved = isRouterPlan ? "采用批处理降低 Router 延迟" : "为 Supervisor 增加并行审查";
      return {
        summary: `按已确认方案继续：${resolved}`,
        objectives: [{ summary: resolved, timing: "current", kind: "change" }],
        intent: "new_task", targetActiveRun: false, priority: 600, urgency: "normal", relation: "same_goal",
        acceptanceCriteria: [`实现已确认方案：${resolved}`], scope: resolved, nonGoals: [], confidence: 0.99,
        reason: `通过 Session context 将“按刚才方案继续”解析为：${resolved}`,
      };
    } });
    const message = (content: string) => [{ id: 1, sessionId: "session-1", role: "assistant", content, createdAt: 1 }] as import("../src/core/types.js").Message[];

    const routerResult = await router.analyze("按刚才方案继续", undefined, { recentMessages: message("已确认方案：采用批处理降低 Router 延迟") });
    const supervisorResult = await router.analyze("按刚才方案继续", undefined, { recentMessages: message("已确认方案：为 Supervisor 增加并行审查") });

    expect(routerResult.objectives[0]?.summary).toBe("采用批处理降低 Router 延迟");
    expect(supervisorResult.objectives[0]?.summary).toBe("为 Supervisor 增加并行审查");
    expect(routerResult.summary).not.toBe(supervisorResult.summary);
    expect(routerResult.reason).toContain("Session context");
    expect(supervisorResult.reason).toContain("Session context");
  });

  it("allows background-only information to update an active Run without inventing tasks", async () => {
    const router = new SessionInputRouter({ request: async () => ({
      summary: "补充 3220 对应 /opt/tagent-core 的运行背景", objectives: [], intent: "update_active_context", targetActiveRun: true,
      priority: 850, urgency: "normal", relation: "same_goal", acceptanceCriteria: [], scope: "活动任务运行环境背景", nonGoals: [], confidence: 0.99,
      reason: "用户只补充环境映射，没有要求新增工作",
    }) });
    const result = await router.analyze("背景信息：/opt/tagent-core 对应 3220，/root/tagent/tagent-core 对应 3210。", active);
    expect(result).toMatchObject({ intent: "update_active_context", targetRunId: "run-1", objectives: [], acceptanceCriteria: [], routerVersion: "llm-semantic-v1" });
  });
});
