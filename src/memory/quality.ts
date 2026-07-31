import { createHash } from "node:crypto";
import type { MemoryCard, MemoryScope, TopicDescriptor, WarmMemory } from "./types.js";

const CONTROL_PLANE_PATTERNS = [
  /^(?:Goal|Outcome)\s*:/i,
  /^(?:TaskRun\s+)?(?:completed|blocked|failed)\b/i,
  /^Verified check\s*\[/i,
  /^Published artifact\s*\[/i,
  /(?:^|\s)(?:PASS|FAIL|missing=\[\]|HTTP\s*\d{3})(?:\s|$)/i,
  /(?:^|\s)(?:file:\/\/|\/(?:root|opt|tmp|var|home)\/)[^\s]+/i,
  /\b\d+\s*(?:bytes?|字节)\b/i,
  /(?:文件|制品|artifact).{0,30}(?:已存在|已发布|路径|大小)/i,
  /(?:测试|检查|验证).{0,30}(?:通过|完成|成功)/i,
  /(?:标识符|identifier).{0,30}(?:匹配|TaskRun)/i,
];

const MALFORMED_NEGATION = [
  /不仍(?:然)?/,
  /不与.{0,80}(?:存在|发生).{0,30}(?:冲突|风险)/,
  /不评价.{0,80}(?:混乱|杂乱|糟糕|很好|良好)/,
  /(?:没有|未|不).{0,20}(?:没有|未|不)(?:能|可|是|存在|发生)/,
];

const QUESTION_OR_REQUEST = /(?:[?？]\s*$)|^(?:(?:请|帮我|麻烦)(?:检查|审计|排查|修复|实现|运行|执行|部署|合并|查看|确认|分析|调查)|为什么|为何|怎么|如何|是否|能否|可否|检查|审计|排查|修复|实现|运行|执行|部署|合并|查看|确认|分析|调查)|^(?:why|how|can you|could you|please|check|audit|debug|fix|implement|run|deploy|merge)\b/i;
const ORG_CUE = /(?:组织架构|公司架构|汇报|上级|管理|首席执行官|运营总监|战略总监|主管[CD]|研究员[AB]|实习生[EF]|共同上级)/i;
const PR_CUE = /(?:GitHub|PR\s*#?\d+|pull request|origin\/main|合并冲突|干净合并|rebase)/i;
const RESIDENCE_CUE = /(?:Sway|乔哲|前滩|住哪|住在|住所|隔壁|邻居)/i;
const PROFILE_CUE = /(?:我是谁|我叫什么|我的名字|我的姓名|怎么称呼我|用户姓名|用户称呼|偏好|喜欢|不喜欢|习惯|who am i|what(?:'s| is) my name)/i;
const IDENTITY_CUE = /(?:我是谁|我叫什么|我的名字|我的姓名|怎么称呼我|用户姓名|用户称呼|who am i|what(?:'s| is) my name)/i;

export type MemoryDomain = "user_profile" | "organization" | "project" | "residence" | "general";

export function isControlPlaneText(text: string) {
  const value = text.trim();
  return CONTROL_PLANE_PATTERNS.some((pattern) => pattern.test(value));
}

export function isOneOffRequest(text: string) {
  return QUESTION_OR_REQUEST.test(text.trim()) && !/(?:记住|记录|以后|始终|总是|偏好|喜欢|不喜欢|我叫|我的名字)/i.test(text);
}

export function hasMalformedNegation(text: string) {
  return MALFORMED_NEGATION.some((pattern) => pattern.test(text));
}

export function isDurableMemory(record: WarmMemory) {
  const title = record.kind === "preference" ? record.dimension : record.title;
  const content = record.kind === "preference" ? record.value : record.content;
  const combined = `${title}\n${content}\n${record.summary}`;
  if (isControlPlaneText(title) || isControlPlaneText(content) || isControlPlaneText(record.summary)) return false;
  if (hasMalformedNegation(combined)) return false;
  if (record.provenance?.sourceRole === "system") return false;
  if (record.provenance?.evidenceClass === "task_outcome") return false;
  if (isOneOffRequest(content) && record.kind !== "preference" && record.kind !== "procedure") return false;
  if (record.kind === "episode" && /(?:已发布|已完成|验证|审计|检查|测试|部署|合并|同步|提交标识符|TaskRun)/i.test(combined)) return false;
  return true;
}

export function canonicalOrganizationTopic(scope: MemoryScope) {
  return `${scope.type}.${scope.id}.knowledge.company-org-structure`;
}

export function isOrganizationEvidence(text: string) {
  return ORG_CUE.test(text) && /(?:管理|汇报给|直属上级|reports?\s+to)/i.test(text);
}

export function isOrganizationDerivedOrMetadata(text: string) {
  return /(?:完整链路|组织链路|首次相交|共同上级|节点数|层级数|关系数|\d+个节点|\d+条|\d+个层级|\.md|文件|PASS|发布|验证)/i.test(text);
}

export function canonicalizeTopic(record: WarmMemory, originalContent = "") {
  const text = record.kind === "preference" ? record.value : `${record.title} ${record.content} ${record.summary}`;
  if ((ORG_CUE.test(originalContent) || ORG_CUE.test(text)) && isOrganizationEvidence(text)) return canonicalOrganizationTopic(record.scope);
  return undefined;
}

export function canonicalFingerprint(record: WarmMemory) {
  const raw = record.kind === "preference" ? `${record.kind}|${record.dimension}|${record.value}` : `${record.kind}|${record.content}`;
  const normalized = raw.toLowerCase()
    .replace(/[“”"'`*_#：:，,。.!！?？\s]/g, "")
    .replace(/家(?:住)?在|家位于|居住在/g, "住在")
    .replace(/两家是邻居|是邻居|住在其隔壁|住隔壁/g, "邻居")
    .replace(/不爱吃|不喜欢吃|不吃/g, "不偏好食物")
    .replace(/爱吃|喜欢吃/g, "偏好食物")
    .replace(/仍然|仍明确|目前|当前/g, "");
  return createHash("sha256").update(`${record.scope.type}:${record.scope.id}:${normalized}`).digest("hex");
}

export function inferMemoryDomain(value: Pick<MemoryCard, "title" | "content" | "topicIds"> | TopicDescriptor): MemoryDomain {
  const topicIds = "topicIds" in value ? value.topicIds : [value.topicId];
  const text = `${value.title} ${"content" in value ? value.content : value.description} ${topicIds.join(" ")}`;
  if (/user-profile\.identity/i.test(text) || IDENTITY_CUE.test(text)) return "user_profile";
  if (/knowledge\.company-org-structure/i.test(text) || ORG_CUE.test(text)) return "organization";
  if (PR_CUE.test(text)) return "project";
  if (RESIDENCE_CUE.test(text)) return "residence";
  return "general";
}

export function routeRecallDomain(cue: string): MemoryDomain | undefined {
  if (PROFILE_CUE.test(cue)) return "user_profile";
  if (ORG_CUE.test(cue)) return "organization";
  if (PR_CUE.test(cue)) return "project";
  if (RESIDENCE_CUE.test(cue)) return "residence";
  return undefined;
}

export function relevantToDomain(card: Pick<MemoryCard, "title" | "content" | "topicIds">, domain?: MemoryDomain) {
  if (!domain) return inferMemoryDomain(card) !== "user_profile";
  return inferMemoryDomain(card) === domain;
}

export function polarityClass(text: string): "positive" | "negative" | "unknown" {
  if (/(?:不存在|没有|无法|不能|不可|未能|未通过|不喜欢|不偏好|无冲突|not_|does not|cannot|can't|failed to)/i.test(text)) return "negative";
  if (/(?:存在|仍有|发生|可以|能够|已通过|喜欢|偏好|has |is |can |passed)/i.test(text)) return "positive";
  return "unknown";
}

export function suppressConflictingCards(cards: MemoryCard[]) {
  const result: MemoryCard[] = [];
  const groups = new Map<string, MemoryCard[]>();
  for (const card of cards) {
    const key = `${inferMemoryDomain(card)}:${card.title.toLowerCase().replace(/(?:不|未|无|仍|当前|目前|fact:|episode:|\s)/g, "")}`;
    const group = groups.get(key) ?? [];
    group.push(card);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const polarities = new Set(group.map((card) => polarityClass(`${card.title} ${card.content}`)).filter((value) => value !== "unknown"));
    if (polarities.size > 1) result.push([...group].sort((a, b) => b.score - a.score)[0]);
    else result.push(...group);
  }
  return result;
}

export function deduplicateCards(cards: MemoryCard[]) {
  const seen = new Set<string>();
  const result: MemoryCard[] = [];
  for (const card of cards) {
    const key = `${inferMemoryDomain(card)}:${card.content.toLowerCase().replace(/[\s，,。.!！?？:：]/g, "").replace(/家(?:住)?在|家位于/g, "住在").replace(/是邻居|住在其隔壁/g, "邻居")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(card);
  }
  return result;
}
