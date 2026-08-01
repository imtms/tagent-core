import { describe, expect, it } from "vitest";
import { SessionInputRouter } from "../src/core/session-input-router.js";
import type { TaskRun } from "../src/core/types.js";

const active = { id: "run-1", goal: "发布 0.1.4", status: "running", phase: "implement" } as TaskRun;

describe("SessionInputRouter", () => {
  const router = new SessionInputRouter();
  it("routes corrections and safety constraints to the active Run", () => {
    expect(router.analyze("不要重启服务，端口改成 3220", active)).toMatchObject({ intent: "steer_active", targetRunId: "run-1", relation: "correction", priority: 900 });
  });
  it("routes parameters as active context updates", () => {
    expect(router.analyze("补充：代码路径在 /opt/tagent-core", active)).toMatchObject({ intent: "update_active_context", targetRunId: "run-1", relation: "same_goal" });
  });
  it("routes explicit post-completion work as follow-up", () => {
    expect(router.analyze("完成后再补一份部署文档", active)).toMatchObject({ intent: "follow_up_active", targetRunId: "run-1", relation: "follow_up" });
  });
  it("creates a parallel proposal only for explicit independent parallel work", () => {
    expect(router.analyze("同时并行设计另一个独立的移动端客户端", active)).toMatchObject({ intent: "parallel_task", targetRunId: "run-1", relation: "parallel" });
  });
  it("summarizes new tasks instead of using the full raw prompt as their goal", () => {
    const result = router.analyze("请审计当前 Supervisor 的实现差异。然后给出可验证的建议。", undefined);
    expect(result.intent).toBe("new_task");
    expect(result.summary).toBe("审计当前 Supervisor 的实现差异。");
    expect(result.acceptanceCriteria).toHaveLength(2);
  });
});
