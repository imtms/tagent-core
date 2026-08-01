import type { SessionInputAnalysis, SessionInputIntent, TaskRun } from "./types.js";

const ROUTER_VERSION = "rules-v2";
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
const compact = (value: string, limit = 120) => {
  const text = normalize(value).replace(/^(请|麻烦|帮我|please)\s*/i, "");
  const first = text.split(/(?<=[。！？!?])\s*/)[0] || text;
  return first.length <= limit ? first : `${first.slice(0, limit - 1)}…`;
};
const criteria = (summary: string, intent: SessionInputIntent) => intent === "discussion" || intent === "clarification"
  ? [`直接回答“${summary}”`, "明确区分已知事实、推断和不确定性"]
  : intent === "defer" ? [] : [`完成目标：${summary}`, "提供可验证的结果或明确说明阻塞原因"];

const STEER = /(停止|暂停|先别|不要|别再|不允许|禁止|错了|有误|改成|换成|应该用|不要用|撤销|取消|回滚|路径.*(?:是|改)|端口.*(?:是|改)|stop|pause|do not|don't|wrong|instead|switch to|cancel|rollback)/i;
const FOLLOW_UP = /(完成后|做完后|之后再|然后再|最后再|顺便|接着|下一步|after (?:that|this|it)|when (?:done|finished)|then also|follow[- ]?up)/i;
const PARALLEL = /(同时|并行|另外还要|另一个独立|与此同时|in parallel|separately|another independent)/i;
const CONTEXT = /(补充|参数|地址|路径|端口|api\s*key|base\s*url|环境变量|仓库在|代码在|测试地址|额外信息|for context|additional context|the (?:path|port|url|key) is)/i;
const DISCUSSION = /^(?:为什么|为何|怎么理解|解释一下|你觉得|是否应该|什么是|介绍一下|聊聊|what\b|why\b|how\b|explain\b|compare\b)|[?？]$/i;
const CLARIFICATION = /^(?:这个|那个|它|他|她|这里|那里|刚才|上面|前面|which\b|where\b|when\b|who\b).*[?？]$|(?:具体|准确).*(?:哪个|哪里|什么|如何)[?？]$/i;
const DEFER = /^(?:先放着|暂时不做|稍后再做|以后再说|先记下|先排队|defer|later|not now)\s*[。.!！]?$/i;
const CRITICAL = /(立刻|马上|紧急|安全|泄露|删除数据|停止|禁止|critical|urgent|security|leak)/i;

export class SessionInputRouter {
  analyze(content: string, activeRun?: TaskRun): SessionInputAnalysis {
    const source = normalize(content);
    const summary = compact(source);
    const urgency = CRITICAL.test(source) ? "critical" : "normal";
    let intent: SessionInputIntent = DEFER.test(source) ? "defer" : CLARIFICATION.test(source) ? "clarification" : DISCUSSION.test(source) ? "discussion" : "new_task";
    let relation: SessionInputAnalysis["relation"] = "independent";
    let targetRunId: string | null = null;
    let priority = urgency === "critical" ? 950 : intent === "defer" ? 100 : intent === "discussion" || intent === "clarification" ? 350 : 500;
    let confidence = 0.82;
    let reason = intent === "defer" ? "The user explicitly postponed this work; persist it without automatic dispatch." : activeRun ? "Input does not safely match an active-run control rule; keep it as separate queued work." : "No active TaskRun; create a concise TaskRun contract.";

    if (activeRun && intent !== "defer") {
      targetRunId = activeRun.id;
      if (STEER.test(source)) {
        intent = "steer_active"; relation = "correction"; priority = urgency === "critical" ? 1000 : 900; confidence = 0.97;
        reason = "The input corrects, constrains, stops, or redirects the active TaskRun.";
      } else if (FOLLOW_UP.test(source)) {
        intent = "follow_up_active"; relation = "follow_up"; priority = 700; confidence = 0.93;
        reason = "The input explicitly asks for work after the active TaskRun settles.";
      } else if (CONTEXT.test(source)) {
        intent = "update_active_context"; relation = "same_goal"; priority = 850; confidence = 0.91;
        reason = "The input supplies parameters or evidence needed by the active TaskRun.";
      } else if (PARALLEL.test(source)) {
        intent = "parallel_task"; relation = "parallel"; priority = 650; confidence = 0.9;
        reason = "The input explicitly describes independent work that may run in parallel.";
      } else {
        targetRunId = null;
      }
    }

    return {
      summary,
      intent,
      targetRunId,
      priority,
      urgency,
      relation,
      acceptanceCriteria: criteria(summary, intent),
      scope: summary,
      nonGoals: [],
      confidence,
      reason,
      routerVersion: ROUTER_VERSION,
    };
  }
}
