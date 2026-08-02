import { createHash } from "node:crypto";
import type { CanonicalSPO, MemoryCard, MemoryScope, TopicDescriptor, WarmMemory } from "./types.js";

/** Generic control-plane signals. Domain entities belong in tests or configured ontologies, never here. */
const CONTROL_PLANE_PATTERNS = [
  /^(?:Goal|Outcome)\s*:/i, /^(?:TaskRun\s+)?(?:completed|blocked|failed)\b/i,
  /^Verified check\s*\[/i, /^Published artifact\s*\[/i,
  /(?:^|\s)(?:PASS|FAIL|missing=\[\]|HTTP\s*\d{3})(?:\s|$)/i,
  /(?:^|\s)(?:file:\/\/|\/(?:root|opt|tmp|var|home)\/)[^\s]+/i,
  /\b\d+\s*(?:bytes?|字节)\b/i,
  /(?:文件|制品|artifact).{0,30}(?:已存在|已发布|路径|大小)/i,
  /(?:测试|检查|验证).{0,30}(?:通过|完成|成功)/i,
];
const MALFORMED_NEGATION=[/不仍(?:然)?/,/不与.{0,80}(?:存在|发生).{0,30}(?:冲突|风险)/,/(?:没有|未|不).{0,20}(?:没有|未|不)(?:能|可|是|存在|发生)/];
const QUESTION_OR_REQUEST=/(?:[?？]\s*$)|^(?:(?:请|帮我|麻烦)(?:检查|审计|排查|修复|实现|运行|执行|部署|合并|查看|确认|分析|调查)|为什么|为何|怎么|如何|是否|能否|可否|检查|审计|排查|修复|实现|运行|执行|部署|合并|查看|确认|分析|调查)|^(?:why|how|can you|could you|please|check|audit|debug|fix|implement|run|deploy|merge)\b/i;

export type MemoryDomain="user_profile"|"organization"|"software_project"|"residence"|"general";
export interface DomainOntologyRule { id:MemoryDomain; cuePatterns:RegExp[]; recordPatterns:RegExp[]; topicPatterns?:RegExp[] }
export class DomainOntology {
  constructor(readonly rules:DomainOntologyRule[]=defaultOntologyRules()){}
  routeCue(cue:string){return this.rules.find((rule)=>rule.cuePatterns.some((p)=>p.test(cue)))?.id;}
  classify(value:Pick<MemoryCard,"title"|"content"|"topicIds">|TopicDescriptor){const topicIds="topicIds" in value?value.topicIds:[value.topicId];const text=`${value.title} ${"content" in value?value.content:value.description} ${topicIds.join(" ")}`;return this.rules.find((rule)=>(rule.topicPatterns??[]).some((p)=>p.test(text))||rule.recordPatterns.some((p)=>p.test(text)))?.id??"general";}
}
export function defaultOntologyRules():DomainOntologyRule[]{return [
 {id:"user_profile",cuePatterns:[/(?:我是谁|我叫什么|我的名字|我的姓名|怎么称呼我|who am i|what(?:'s| is) my name)/i],recordPatterns:[/(?:用户姓名|用户称呼|user identity|preferred name)/i],topicPatterns:[/user-profile\.identity/i]},
 {id:"organization",cuePatterns:[/(?:组织架构|公司架构|汇报关系|直属上级|共同上级|reports? to|org chart)/i],recordPatterns:[/(?:管理|汇报给|直属上级|直属管理|reports? to)/i],topicPatterns:[/(?:knowledge\..*org|organization|org-structure)/i]},
 {id:"software_project",cuePatterns:[/(?:pull request|\bPR\s*#?\d+|合并冲突|rebase|代码库|仓库)/i],recordPatterns:[/(?:pull request|\bPR\s*#?\d+|merge conflict|合并冲突|rebase)/i],topicPatterns:[/(?:project|repository|software)/i]},
 {id:"residence",cuePatterns:[/(?:住哪里|住哪|住在|住所|隔壁|邻居|where does .* live)/i],recordPatterns:[/(?:住在|居住|住所|隔壁|邻居|lives? in|neighbor)/i]},
];}
const ontology=new DomainOntology();
export function isControlPlaneText(text:string){const value=text.trim();return CONTROL_PLANE_PATTERNS.some((p)=>p.test(value));}
export function isOneOffRequest(text:string){return QUESTION_OR_REQUEST.test(text.trim())&&!/(?:记住|记录|以后|始终|总是|偏好|喜欢|不喜欢|我叫|我的名字)/i.test(text);}
export function hasMalformedNegation(text:string){return MALFORMED_NEGATION.some((p)=>p.test(text));}
export type MemoryQualityRejectionReason = "control_plane" | "malformed_negation" | "task_outcome" | "one_off_request" | "operational_episode" | "semantic_inconsistent" | "unsupported_claim";
export function hardMemoryQualityRejectionReason(record:WarmMemory):MemoryQualityRejectionReason|undefined {const title=record.kind==="preference"?record.dimension:record.title;const content=record.kind==="preference"?record.value:record.content;const combined=`${title}\n${content}\n${record.summary}`;if([title,content,record.summary].some(isControlPlaneText))return"control_plane";if(hasMalformedNegation(combined))return"malformed_negation";if(record.provenance?.sourceRole==="system"||record.provenance?.evidenceClass==="task_outcome")return"task_outcome";return undefined;}
export function memoryQualityRejectionReason(record:WarmMemory):MemoryQualityRejectionReason|undefined {const hard=hardMemoryQualityRejectionReason(record);if(hard)return hard;const title=record.kind==="preference"?record.dimension:record.title;const content=record.kind==="preference"?record.value:record.content;const combined=`${title}\n${content}\n${record.summary}`;if(isOneOffRequest(content)&&record.kind!=="preference"&&record.kind!=="procedure")return"one_off_request";if(record.kind==="episode"&&/(?:已发布|已完成|验证|审计|检查|测试|部署|合并|同步|TaskRun)/i.test(combined))return"operational_episode";if(!semanticConsistent(record))return"semantic_inconsistent";return undefined;}
export function isDurableMemory(record:WarmMemory){return memoryQualityRejectionReason(record)===undefined;}
export function semanticConsistent(record:WarmMemory){if(!record.semantic)return true;const text=record.kind==="preference"?record.value:`${record.title} ${record.content}`;const detected=polarityClass(text);return record.semantic.polarity==="unknown"||detected==="unknown"||detected===record.semantic.polarity;}
export function canonicalSPO(record:WarmMemory):CanonicalSPO {if(record.semantic)return {...record.semantic,subject:normalizeTerm(record.semantic.subject),predicate:normalizePredicate(record.semantic.predicate),object:normalizeTerm(record.semantic.object)};const text=record.kind==="preference"?record.value:record.content;const match=/^(.+?)\s+(不喜欢吃|喜欢吃|住在|与.+?是邻居|管理|汇报给|使用|采用|依赖|是)\s+(.+)$/.exec(text.trim());return{subject:normalizeTerm(match?.[1]??record.entityIds[0]??"unknown"),predicate:normalizePredicate(match?.[2]??(record.kind==="preference"?record.dimension:record.kind)),object:normalizeTerm(match?.[3]??text),polarity:polarityClass(text)};}
export function canonicalFingerprint(record:WarmMemory){const spo=canonicalSPO(record);return createHash("sha256").update(`${record.scope.type}:${record.scope.id}:${record.kind}:${spo.subject}|${spo.predicate}|${spo.object}|${spo.polarity}`).digest("hex");}
export function inferMemoryDomain(value:Pick<MemoryCard,"title"|"content"|"topicIds">|TopicDescriptor){return ontology.classify(value);}
export function routeRecallDomain(cue:string){return ontology.routeCue(cue);}
export function relevantToDomain(card:Pick<MemoryCard,"title"|"content"|"topicIds">,domain?:MemoryDomain){if(!domain)return inferMemoryDomain(card)!=="user_profile";return inferMemoryDomain(card)===domain;}
export function polarityClass(text:string):CanonicalSPO["polarity"]{if(/(?:不存在|没有|无法|不能|不可|未能|未通过|不喜欢|不偏好|无冲突|not_|does not|cannot|can't|failed to)/i.test(text))return"negative";if(/(?:存在|仍有|发生|可以|能够|已通过|喜欢|偏好|has |is |can |passed)/i.test(text))return"positive";return"unknown";}
export function conflictKey(card:MemoryCard){const s=card.semantic;if(s&&s.subject!=="unknown"&&!s.subject.includes("entity"))return `${normalizeTerm(s.subject)}|${normalizePredicate(s.predicate)}|${normalizeTerm(s.object)}`;return `${inferMemoryDomain(card)}:${card.title.toLowerCase().replace(/(?:不|未|无|仍|当前|目前|fact:|episode:|\s)/g,"")}`;}
export function suppressConflictingCards(cards:MemoryCard[]){const result:MemoryCard[]=[];const groups=new Map<string,MemoryCard[]>();for(const card of cards){const group=groups.get(conflictKey(card))??[];group.push(card);groups.set(conflictKey(card),group);}for(const group of groups.values()){const current=group.filter((c)=>!c.validTo||c.validTo>Date.now());const pool=current.length?current:group;const polarities=new Set(pool.map((c)=>c.semantic?.polarity??polarityClass(`${c.title} ${c.content}`)).filter((x)=>x!=="unknown"));if(polarities.size>1)result.push([...pool].sort((a,b)=>b.score-a.score)[0]);else result.push(...pool);}return result;}
export function deduplicateCards(cards:MemoryCard[]){const seen=new Set<string>();return cards.filter((card)=>{const key=card.semantic?`${normalizeTerm(card.semantic.subject)}|${normalizePredicate(card.semantic.predicate)}|${normalizeTerm(card.semantic.object)}|${card.semantic.polarity}`:card.content.toLowerCase().replace(/[\s，,。.!！?？:：]/g,"");if(seen.has(key))return false;seen.add(key);return true;});}
function normalizeTerm(value:string){return value.toLowerCase().trim().replace(/[“”"'`*_#：:，,。.!！?？\s]/g,"");}
function normalizePredicate(value:string){return normalizeTerm(value).replace(/家(?:住)?在|家位于|居住在/g,"住在").replace(/两家是邻居|是邻居|住在其隔壁|住隔壁/g,"邻居").replace(/不爱吃|不喜欢吃|不吃/g,"偏好食物").replace(/爱吃|喜欢吃/g,"偏好食物");}
export function canonicalOrganizationTopic(scope:MemoryScope){return `${scope.type}.${scope.id}.knowledge.organization`;}
export function isOrganizationEvidence(text:string){return defaultOntologyRules()[1].recordPatterns.some((p)=>p.test(text));}
export function isOrganizationDerivedOrMetadata(text:string){return /(?:完整链路|首次相交|共同上级|节点数|层级数|关系数|文件|PASS|发布|验证)/i.test(text);}
export function canonicalizeTopic(record:WarmMemory,originalContent=""){const text=record.kind==="preference"?record.value:`${record.title} ${record.content}`;if((routeRecallDomain(originalContent)==="organization"||inferMemoryDomain({title:record.kind==="preference"?record.dimension:record.title,content:text,topicIds:record.topicIds})==="organization")&&isOrganizationEvidence(text))return canonicalOrganizationTopic(record.scope);return undefined;}
