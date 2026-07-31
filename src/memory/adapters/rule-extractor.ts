import { createHash, randomUUID } from "node:crypto";
import type { ExtractorPort } from "../ports.js";
import type { ExtractionProposal, GraphEdge, GraphNode, MemoryKind, MemoryScope, SourceReference, TopicDescriptor } from "../types.js";
import { isControlPlaneText, isOneOffRequest } from "../quality.js";

type EvidenceRole = "user" | "assistant" | "manual";
interface EvidenceSentence { role: EvidenceRole; text: string }

/** Deterministic local extractor. Role labels are security boundaries: assistant text is never user-profile evidence. */
export class RuleBasedExtractor implements ExtractorPort {
  async extract(content: string, sourceRefs: SourceReference[], scope: MemoryScope): Promise<ExtractionProposal> {
    const now = Date.now();
    const records: ExtractionProposal["records"] = [];
    const topics = new Map<string, TopicDescriptor>();
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();

    for (const evidence of evidenceSentences(content)) {
      const identity = evidence.role !== "assistant" ? extractIdentity(evidence.text) : undefined;
      if (identity) {
        const topicId = `${scope.type}.${scope.id}.fact.user-profile.identity`;
        const userNode = profileNode(scope);
        const nameNode = namedPersonNode(identity, scope);
        nodes.set(userNode.id, userNode);
        nodes.set(nameNode.id, nameNode);
        const edge = profileNameEdge(userNode, nameNode, scope);
        edges.set(edge.id, edge);
        const canonical = `用户姓名或称呼是 ${identity}`;
        records.push({ id: randomUUID(), createdAt: now, updatedAt: now, kind: "fact", tier: "hot", scope, title: "User profile: name", content: canonical, summary: canonical, topicIds: [topicId], entityIds: [userNode.id, nameNode.id], status: "active", confidence: 0.99, importance: 1, sourceRefs });
        topics.set(topicId, { topicId, kind: "fact", scope, title: "User identity and preferred name", description: canonical, aliases: ["我是谁", "我叫什么", "我的名字", "用户姓名", "用户称呼", "名字", "姓名", "称呼", "who am i", "what is my name", "my name"], entityIds: [userNode.id, nameNode.id], relatedTopicIds: [], embeddingText: `用户身份 姓名 名字 称呼 ${identity} who am i my name`, status: "active", updatedAt: now });
        continue;
      }

      const food = evidence.role !== "assistant" ? extractFoodPreferences(evidence.text, scope, sourceRefs, now) : undefined;
      if (food?.records.length) {
        for (const record of food.records) records.push(record);
        for (const topic of food.topics) topics.set(topic.topicId, topic);
        for (const node of food.nodes) nodes.set(node.id, node);
        for (const edge of food.edges) edges.set(edge.id, edge);
        continue;
      }

      // Assistant output is not durable evidence. Persist only user/manual statements; otherwise
      // task summaries, diagnostics, and speculative answers pollute long-term memory.
      if (evidence.role === "assistant") continue;
      const sentence = evidence.text;
      if (isControlPlaneText(sentence) || isOneOffRequest(sentence)) continue;
      const preference = /(?:我|用户|user).{0,20}(?:喜欢|偏好|希望|不要|不喜欢|习惯|prefer|always|never)/i.test(sentence);
      const procedure = /(?:以后|每次|始终|必须|务必|流程|步骤|from now on|always|must)/i.test(sentence) && !preference;
      if (!preference && !procedure && looksLikeOperationalRequest(sentence)) continue;
      const important = preference || procedure || /(决定|使用|采用|改为|迁移|完成|失败|依赖|选择|架构|实现|数据库|decision|uses|depends|completed|failed|migrate)/i.test(sentence);
      if (!important) continue;
      const kind: MemoryKind = preference ? "preference" : procedure ? "procedure" : /(完成|失败|讨论|上周|昨天|今天|completed|failed|discussed)/i.test(sentence) ? "episode" : "fact";
      const extractedEntities = entities(sentence, scope);
      for (const node of extractedEntities) nodes.set(node.id, node);
      const topicId = topicFrom(sentence, scope, kind, extractedEntities);
      const entityIds = extractedEntities.map((x) => x.id);
      if (kind === "preference") records.push({ id: randomUUID(), createdAt: now, updatedAt: now, kind: "preference", tier: "hot", scope, dimension: preferenceDimension(sentence), value: sentence, summary: sentence.slice(0, 240), topicIds: [topicId], entityIds, applicability: scope.type === "workspace" ? "workspace" : "global", strength: 0.9, origin: "explicit", status: "active", confidence: 0.88, sourceRefs });
      else records.push({ id: randomUUID(), createdAt: now, updatedAt: now, kind, tier: "hot", scope, title: titleFor(sentence, kind), content: sentence, summary: sentence.slice(0, 240), topicIds: [topicId], entityIds, status: "active", confidence: kind === "procedure" ? 0.82 : 0.76, importance: 0.78, sourceRefs });
      const current = topics.get(topicId);
      const aliases = keywords(sentence);
      topics.set(topicId, { topicId, kind, scope, title: current?.title ?? titleFor(sentence, kind), description: [current?.description, sentence].filter(Boolean).join(" ").slice(0, 800), aliases: [...new Set([...(current?.aliases ?? []), ...aliases])].slice(0, 16), entityIds: [...new Set([...(current?.entityIds ?? []), ...entityIds])], relatedTopicIds: current?.relatedTopicIds ?? [], embeddingText: [current?.embeddingText, sentence].filter(Boolean).join("\n").slice(0, 1600), status: "active", updatedAt: now });
      for (const edge of relations(sentence, extractedEntities, scope)) edges.set(edge.id, edge);
    }
    const topicList = [...topics.values()];
    for (const topic of topicList) topic.relatedTopicIds = topicList.filter((other) => other.topicId !== topic.topicId && other.entityIds.some((id) => topic.entityIds.includes(id))).map((x) => x.topicId).slice(0, 8);
    return { records, topics: topicList, nodes: [...nodes.values()], edges: [...edges.values()] };
  }
}

function evidenceSentences(content: string): EvidenceSentence[] {
  const result: EvidenceSentence[] = [];
  let role: EvidenceRole = "manual";
  for (const raw of content.split(/\n+/)) {
    const line = raw.trim();
    if (!line || /^(?:TaskRun\s+)?(?:completed|blocked|failed)$/i.test(line)) continue;
    const match = /^(user|assistant|goal|outcome)\s*:\s*(.*)$/i.exec(line);
    if (match) {
      role = /assistant|outcome/i.test(match[1]) ? "assistant" : "user";
      if (!match[2].trim()) continue;
    }
    const text = (match ? match[2] : line).trim();
    for (const sentence of text.split(/(?<=[。！？.!?])\s+/).map((item) => item.trim()).filter((item) => item.length >= 2)) result.push({ role, text: sentence });
  }
  return result.slice(0, 80);
}

function extractIdentity(text: string): string | undefined {
  if (/[?？]/.test(text) || /(?:什么|啥|谁)(?:名字|姓名|称呼)?|(?:叫|称呼).{0,40}(?:吗|嘛|呢|了吗)$/i.test(text.trim())) return undefined;
  const patterns = [
    /(?:请)?记住(?:我)?(?:叫|是|的名字是|的姓名是)\s*[“"']?([^，。！？,.!?\s“”"']{1,40})/i,
    /(?:我叫|我的名字是|我的姓名是|名字是|姓名是)\s*[“"']?([^，。！？,.!?\s“”"']{1,40})/i,
    /(?:以后)?(?:叫我|称呼我(?:为)?)\s*[“"']?([^，。！？,.!?\s“”"']{1,40})/i,
    /(?:my name is|call me)\s+["']?([\p{L}\p{N}_.-]{1,40})/iu,
  ];
  for (const pattern of patterns) {
    const value = pattern.exec(text)?.[1]?.trim();
    if (value && !/^(?:什么|谁|不知道|unknown|what|who)$/i.test(value)) return value;
  }
  return undefined;
}
function looksLikeOperationalRequest(text: string) {
  const value = text.trim();
  return /[?？]$/.test(value)
    || /^(?:为什么|为何|怎么|如何|是否|能否|可否|请|帮我|麻烦|检查|审计|排查|修复|实现|运行|执行|部署|合并|查看|确认|分析|调查|why|how|can you|could you|please|check|audit|debug|fix|implement|run|deploy|merge)/i.test(value)
    || /(?:请|帮我|麻烦).{0,12}(?:检查|审计|排查|修复|实现|运行|执行|部署|合并|查看|确认|分析|调查)/i.test(value);
}
function stableId(value: string) { return createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0, 24); }
function profileNode(scope: MemoryScope): GraphNode { return { id: `${scope.type}:${scope.id}:entity:user-profile`, type: "user", canonicalName: "用户", aliases: ["我", "user", "用户"], scope }; }
function namedPersonNode(name: string, scope: MemoryScope): GraphNode { return { id: `${scope.type}:${scope.id}:entity:${stableId(`person:${name}`)}`, type: "person", canonicalName: name, aliases: [name.toLowerCase()], scope }; }
function profileNameEdge(from: GraphNode, to: GraphNode, scope: MemoryScope): GraphEdge { return { id: `${scope.type}:${scope.id}:edge:${stableId(`${from.id}:called:${to.id}`)}`, fromId: from.id, predicate: "called", toId: to.id, scope, confidence: 0.99, status: "active" }; }
function keywords(text: string) { return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].filter((x) => !stop.has(x)).slice(0, 12); }
const stop = new Set(["用户", "我们", "这个", "那个", "使用", "希望", "应该", "必须", "user", "uses", "the", "and", "with"]);
function entities(text: string, scope: MemoryScope): GraphNode[] { const candidates = [...(text.match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) ?? []), ...(text.match(/[\p{Script=Han}]{2,12}(?:项目|模块|服务|数据库|架构|语言)/gu) ?? [])]; return [...new Set(candidates)].filter((x) => !stop.has(x.toLowerCase())).slice(0, 10).map((name) => ({ id: `${scope.type}:${scope.id}:entity:${stableId(name)}`, type: entityType(name), canonicalName: name, aliases: [name.toLowerCase()], scope })); }
function entityType(name: string) { return /postgres|sqlite|mysql|数据库/i.test(name) ? "database" : /rust|typescript|python|语言/i.test(name) ? "technology" : /tagent|项目|project/i.test(name) ? "project" : "concept"; }
function relations(text: string, nodes: GraphNode[], scope: MemoryScope): GraphEdge[] { if (nodes.length < 2) return []; const predicate = /(依赖|depends)/i.test(text) ? "depends_on" : /(偏好|喜欢|prefer)/i.test(text) ? "prefers" : /(迁移|改为|migrate)/i.test(text) ? "migrated_to" : /(使用|采用|uses)/i.test(text) ? "uses" : "related_to"; const from = nodes[0], to = nodes[1]; return [{ id: `${scope.type}:${scope.id}:edge:${stableId(`${from.id}:${predicate}:${to.id}`)}`, fromId: from.id, predicate, toId: to.id, scope, confidence: 0.72, status: "active" }]; }
function preferenceDimension(text: string) { if (/语言|中文|英文|回答|沟通|concise|简洁/i.test(text)) return "communication"; if (/rust|typescript|python|技术|工具/i.test(text)) return "technology"; if (/流程|步骤|确认|工作/i.test(text)) return "workflow"; return "general"; }
function titleFor(text: string, kind: MemoryKind) { const prefix = kind === "preference" ? "Preference" : kind === "procedure" ? "Procedure" : kind === "episode" ? "Episode" : "Fact"; return `${prefix}: ${text}`.slice(0, 100); }
function topicFrom(text: string, scope: MemoryScope, kind: MemoryKind, nodes: GraphNode[]) { const anchor = nodes[0]?.canonicalName ?? keywords(text)[0] ?? "general"; const concept = preferenceDimension(text); return `${scope.type}.${scope.id}.${kind}.${slug(anchor)}.${slug(concept)}`.slice(0, 180); }
function slug(value: string) { return value.toLowerCase().replace(/[^\p{L}\p{N}_.-]/gu, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "general"; }

function extractFoodPreferences(text:string,scope:MemoryScope,sourceRefs:SourceReference[],now:number):ExtractionProposal|undefined {
  if(!/(爱吃|喜欢吃|不爱吃|不喜欢吃|不吃|好吃)/.test(text))return undefined;
  const records:ExtractionProposal["records"]=[],topics:TopicDescriptor[]=[],edges:GraphEdge[]=[];
  const people=new Map<string,GraphNode>();const add=(subject:string,food:string,negative:boolean,confidence=.94)=>{food=food.replace(/[，。！？,.!?].*$/,"").trim();if(!food||food.length>30)return;const subjectNode=subject==="用户"?profileNode(scope):namedPersonNode(subject,scope);const foodNode:GraphNode={id:`${scope.type}:${scope.id}:entity:${stableId(`food:${food}`)}`,type:"food",canonicalName:food,aliases:[food],scope};people.set(subjectNode.id,subjectNode);people.set(foodNode.id,foodNode);const topicId=`${scope.type}.${scope.id}.preference.${slug(subject)}.food`;const value=`${subject} ${negative?"不喜欢吃":"喜欢吃"} ${food}`;records.push({id:randomUUID(),kind:"preference",tier:"hot",scope,dimension:"food",value,summary:value,topicIds:[topicId],entityIds:[subjectNode.id,foodNode.id],applicability:"global",strength:.95,origin:"explicit",status:"active",confidence,sourceRefs,createdAt:now,updatedAt:now});topics.push({topicId,kind:"preference",scope,title:`${subject}的饮食偏好`,description:value,aliases:[subject,food,"饮食偏好","爱吃","不爱吃"],entityIds:[subjectNode.id,foodNode.id],relatedTopicIds:[],embeddingText:value,status:"active",updatedAt:now});edges.push({id:`${scope.type}:${scope.id}:edge:${stableId(`${subjectNode.id}:${negative?"not_prefers":"prefers"}:${foodNode.id}`)}`,fromId:subjectNode.id,predicate:negative?"not_prefers":"prefers",toId:foodNode.id,scope,confidence,status:"active"});};
  const self=[...text.matchAll(/(?:我|用户)(不爱吃|不喜欢吃|不吃|爱吃|喜欢吃)\s*([^，。！？,.!?但是也且\s]{1,20})/g)];for(const m of self)add("用户",m[2],m[1].startsWith("不"));
  const friendSegment=/我有个朋友\s*([^，。！？,.!?]{2,40})/u.exec(text)?.[1];if(friendSegment){const fm=/^([\p{Script=Han}]{2,6}?)(?:也)?(?:是)?(?:也)?(?:爱吃|喜欢吃)\s*([^，。！？,.!?\s]{1,20})/u.exec(friendSegment);if(fm)add(fm[1].replace(/也$/,""),fm[2],false);else{const same=/^([\p{Script=Han}]{2,6}?)(?:也)?是$/u.exec(friendSegment.trim());const selfFood=self.find((m)=>!m[1].startsWith("不"))?.[2];if(same&&selfFood)add(same[1],selfFood,false);}}

  const direct=/^([\p{Script=Han}]{2,6}?)(?:爱吃|喜欢吃)\s*([^，。！？,.!?\s]{1,20})/u.exec(text);if(direct)add(direct[1],direct[2],false);
  const named=/^([\p{Script=Han}]{2,6})觉得\s*([\p{L}]{1,20}?)(?=(?:也)?(?:很好吃|好吃))/u.exec(text);if(named)add(named[1],named[2],false,.88);
  return records.length?{records,topics,nodes:[...people.values()],edges}:undefined;
}
