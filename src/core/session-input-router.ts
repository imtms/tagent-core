import type { SessionInputAnalysis, SessionInputIntent, TaskObjective, TaskRun } from "./types.js";

const ROUTER_VERSION = "semantic-rules-v3";
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
const politePrefix = /^(?:请|麻烦|帮我|请你|please|could you|would you)\s*/i;
const STEER = /(停止|暂停|先别|不要|别再|不允许|禁止|错了|有误|改成|换成|应该用|不要用|撤销|取消|回滚|stop|pause|do not|don't|wrong|instead|switch to|cancel|rollback)/i;
const FOLLOW_UP = /(完成后|做完后|之后再|然后再|最后再|接着|下一步|after (?:that|this|it)|when (?:done|finished)|then|follow[- ]?up)/i;
const PARALLEL = /(同时|并行|与此同时|in parallel|separately|meanwhile)/i;
const CONTEXT = /(补充|参数|地址|路径|端口|api\s*key|base\s*url|环境变量|仓库在|代码在|测试地址|额外信息|for context|additional context|the (?:path|port|url|key) is)/i;
const DISCUSSION = /^(?:为什么|为何|怎么理解|解释一下|你觉得|是否应该|什么是|介绍一下|聊聊|what\b|why\b|how\b|explain\b|compare\b)|[?？]$/i;
const CLARIFICATION = /^(?:这个|那个|它|他|她|这里|那里|刚才|上面|前面|which\b|where\b|when\b|who\b).*[?？]$|(?:具体|准确).*(?:哪个|哪里|什么|如何)[?？]$/i;
const DEFER = /^(?:先放着|暂时不做|稍后再做|以后再说|先记下|先排队|defer|later|not now)\s*[。.!！]?$/i;
const CRITICAL = /(立刻|马上|紧急|安全|泄露|删除数据|停止|禁止|critical|urgent|security|leak)/i;

function splitClauses(source: string) {
  return source.replace(politePrefix, "").split(/(?:[。；;！？!?]\s*|，然后|，并且|，同时|\bthen\b|\band also\b)/i).map(normalize).filter((item) => item.length >= 2);
}
function objectiveKind(text: string): TaskObjective["kind"] {
  if (/(测试|验证|检查|确认|test|verify|check)/i.test(text)) return "verify";
  if (/(文档|说明|readme|document)/i.test(text)) return "document";
  if (/(发布|发版|release|deploy)/i.test(text)) return "release";
  if (/(审计|调查|分析|定位|排查|audit|investigate|analy[sz]e|debug)/i.test(text)) return "investigate";
  if (/(修复|实现|完善|改造|更新|删除|迁移|部署|重启|启动|停止|拉取|fix|implement|improve|update|remove|migrate|refactor|deploy|restart|start|stop|pull)/i.test(text)) return "change";
  if (DISCUSSION.test(text)) return "answer";
  return "other";
}
function concise(text: string, limit = 140) {
  const cleaned = normalize(text).replace(politePrefix, "").replace(/^(?:然后|并且|同时|另外|再|and|then)\s*/i, "");
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit - 1)}…`;
}
function objectives(source: string): TaskObjective[] {
  const clauses = splitClauses(source);
  return (clauses.length ? clauses : [source]).map((clause, index) => ({
    id: `objective-${index + 1}`,
    summary: concise(clause),
    timing: PARALLEL.test(clause) ? "parallel" : FOLLOW_UP.test(clause) || /^(?:最后|之后|完成后|做完后|then|after)/i.test(clause) ? "follow_up" : "current",
    kind: objectiveKind(clause),
  }));
}
function criterion(item: TaskObjective) {
  const result = `交付目标结果：${item.summary}`;
  if (item.kind === "change") return [result, `提供“${item.summary}”相关的变更证据和回归验证`];
  if (item.kind === "verify") return [result, `报告验证方法、实际结果和失败项`];
  if (item.kind === "investigate") return [result, `给出根因、代码或运行证据以及可执行结论`];
  if (item.kind === "release") return [result, `提供版本、提交、发布门禁和发布状态证据`];
  if (item.kind === "document") return [result, `说明文档变更位置并验证无漂移`];
  return [result];
}

export class SessionInputRouter {
  analyze(content: string, activeRun?: TaskRun): SessionInputAnalysis {
    const source = normalize(content);
    const parsedObjectives = objectives(source);
    const primary = parsedObjectives.find((item) => item.timing === "current") ?? parsedObjectives[0];
    const summary = parsedObjectives.length === 1 ? primary.summary : parsedObjectives.map((item) => item.summary).join("；").slice(0, 240);
    const urgency = CRITICAL.test(source) ? "critical" : "normal";
    let intent: SessionInputIntent = DEFER.test(source) ? "defer" : CLARIFICATION.test(source) ? "clarification" : DISCUSSION.test(source) && parsedObjectives.length === 1 ? "discussion" : "new_task";
    let relation: SessionInputAnalysis["relation"] = "independent";
    let targetRunId: string | null = null;
    let priority = urgency === "critical" ? 950 : intent === "defer" ? 100 : intent === "discussion" || intent === "clarification" ? 350 : 500;
    let confidence = parsedObjectives.length > 1 ? 0.88 : 0.9;
    let reason = intent === "defer" ? "The user explicitly postponed this work; persist it without dispatch." : activeRun ? "The input forms an independent goal contract rather than an active-run control instruction." : `Parsed ${parsedObjectives.length} semantic objective(s) into a TaskRun contract.`;

    if (activeRun && intent !== "defer") {
      targetRunId = activeRun.id;
      const hasParallel = parsedObjectives.some((item) => item.timing === "parallel");
      const hasFollowUp = parsedObjectives.some((item) => item.timing === "follow_up");
      if (STEER.test(source)) { intent = "steer_active"; relation = "correction"; priority = urgency === "critical" ? 1000 : 900; confidence = 0.97; reason = "The input corrects or constrains the active TaskRun; semantic objectives are retained in the routing receipt."; }
      else if (CONTEXT.test(source) && !hasParallel && !hasFollowUp) { intent = "update_active_context"; relation = "same_goal"; priority = 850; confidence = 0.93; reason = "The input supplies parameters or evidence for the active TaskRun."; }
      else if (hasParallel) { intent = "parallel_task"; relation = "parallel"; priority = 650; confidence = 0.92; reason = "At least one parsed objective is explicitly independent and parallel."; }
      else if (hasFollowUp) { intent = "follow_up_active"; relation = "follow_up"; priority = 700; confidence = 0.93; reason = "Parsed objectives are explicitly sequenced after the active TaskRun."; }
      else targetRunId = null;
    }

    const acceptanceCriteria = intent === "defer" ? [] : [...new Set(parsedObjectives.flatMap(criterion))];
    return { summary, objectives: parsedObjectives, intent, targetRunId, priority, urgency, relation, acceptanceCriteria, scope: parsedObjectives.map((item) => item.summary).join("; "), nonGoals: [], confidence, reason, routerVersion: ROUTER_VERSION };
  }
}
