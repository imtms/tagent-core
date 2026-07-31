import { createHash, randomUUID } from "node:crypto";
import type { ExtractorPort } from "../ports.js";
import type { ExtractionProposal, GraphEdge, GraphNode, MemoryKind, MemoryScope, SourceReference, TopicDescriptor } from "../types.js";

/** Deterministic, local-only extractor. It emits proposals; policy and consolidation remain authoritative. */
export class RuleBasedExtractor implements ExtractorPort {
  async extract(content:string,sourceRefs:SourceReference[],scope:MemoryScope):Promise<ExtractionProposal>{
    const now=Date.now();
    const sentences=content.split(/(?<=[。！？.!?])\s+|\n+/).map((s)=>s.replace(/^(?:user|assistant|goal):\s*/i,"").trim()).filter((s)=>s.length>=6).slice(0,80);
    const records:ExtractionProposal["records"]=[]; const topics=new Map<string,TopicDescriptor>(); const nodes=new Map<string,GraphNode>(); const edges=new Map<string,GraphEdge>();
    for(const sentence of sentences){
      const preference=/(?:我|用户|user).{0,20}(?:喜欢|偏好|希望|不要|不喜欢|习惯|prefer|always|never)/i.test(sentence);
      const procedure=/(?:以后|每次|始终|必须|务必|流程|步骤|from now on|always|must)/i.test(sentence)&&!preference;
      const important=preference||procedure||/(决定|使用|采用|改为|迁移|完成|失败|依赖|选择|架构|实现|数据库|decision|uses|depends|completed|failed|migrate)/i.test(sentence);
      if(!important)continue;
      const kind:MemoryKind=preference?"preference":procedure?"procedure":/(完成|失败|讨论|上周|昨天|今天|completed|failed|discussed)/i.test(sentence)?"episode":"fact";
      const extractedEntities=entities(sentence,scope); for(const node of extractedEntities)nodes.set(node.id,node);
      const topicId=topicFrom(sentence,scope,kind,extractedEntities); const entityIds=extractedEntities.map((x)=>x.id);
      if(kind==="preference")records.push({id:randomUUID(),createdAt:now,updatedAt:now,kind:"preference",tier:"hot",scope,dimension:preferenceDimension(sentence),value:sentence,summary:sentence.slice(0,240),topicIds:[topicId],entityIds,applicability:scope.type==="workspace"?"workspace":"global",strength:0.9,origin:"explicit",status:"active",confidence:0.88,sourceRefs});
      else records.push({id:randomUUID(),createdAt:now,updatedAt:now,kind,tier:"hot",scope,title:titleFor(sentence,kind),content:sentence,summary:sentence.slice(0,240),topicIds:[topicId],entityIds,status:"active",confidence:kind==="procedure"?0.82:0.76,importance:important?0.78:0.4,sourceRefs});
      const current=topics.get(topicId); const aliases=keywords(sentence);
      topics.set(topicId,{topicId,kind,scope,title:current?.title??titleFor(sentence,kind),description:[current?.description,sentence].filter(Boolean).join(" ").slice(0,800),aliases:[...new Set([...(current?.aliases??[]),...aliases])].slice(0,16),entityIds:[...new Set([...(current?.entityIds??[]),...entityIds])],relatedTopicIds:current?.relatedTopicIds??[],embeddingText:[current?.embeddingText,sentence].filter(Boolean).join("\n").slice(0,1600),status:"active",updatedAt:now});
      for(const edge of relations(sentence,extractedEntities,scope))edges.set(edge.id,edge);
    }
    const topicList=[...topics.values()];
    for(const topic of topicList)topic.relatedTopicIds=topicList.filter((other)=>other.topicId!==topic.topicId&&other.entityIds.some((id)=>topic.entityIds.includes(id))).map((x)=>x.topicId).slice(0,8);
    return{records,topics:topicList,nodes:[...nodes.values()],edges:[...edges.values()]};
  }
}
function stableId(value:string){return createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0,24);}
function keywords(text:string){return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu)??[])].filter((x)=>!stop.has(x)).slice(0,12);}
const stop=new Set(["用户","我们","这个","那个","使用","希望","应该","必须","user","uses","the","and","with"]);
function entities(text:string,scope:MemoryScope):GraphNode[]{
  const candidates=[...(text.match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g)??[]),...(text.match(/[\p{Script=Han}]{2,12}(?:项目|模块|服务|数据库|架构|语言)/gu)??[])];
  return [...new Set(candidates)].filter((x)=>!stop.has(x.toLowerCase())).slice(0,10).map((name)=>({id:`${scope.type}:${scope.id}:entity:${stableId(name)}`,type:entityType(name),canonicalName:name,aliases:[name.toLowerCase()],scope}));
}
function entityType(name:string){return /postgres|sqlite|mysql|数据库/i.test(name)?"database":/rust|typescript|python|语言/i.test(name)?"technology":/tagent|项目|project/i.test(name)?"project":"concept";}
function relations(text:string,nodes:GraphNode[],scope:MemoryScope):GraphEdge[]{if(nodes.length<2)return[];const predicate=/(依赖|depends)/i.test(text)?"depends_on":/(偏好|喜欢|prefer)/i.test(text)?"prefers":/(迁移|改为|migrate)/i.test(text)?"migrated_to":/(使用|采用|uses)/i.test(text)?"uses":"related_to";const from=nodes[0],to=nodes[1];return[{id:`${scope.type}:${scope.id}:edge:${stableId(`${from.id}:${predicate}:${to.id}`)}`,fromId:from.id,predicate,toId:to.id,scope,confidence:0.72,status:"active"}];}
function preferenceDimension(text:string){if(/语言|中文|英文|回答|沟通|concise|简洁/i.test(text))return"communication";if(/rust|typescript|python|技术|工具/i.test(text))return"technology";if(/流程|步骤|确认|工作/i.test(text))return"workflow";return"general";}
function titleFor(text:string,kind:MemoryKind){const prefix=kind==="preference"?"Preference":kind==="procedure"?"Procedure":kind==="episode"?"Episode":"Fact";return `${prefix}: ${text}`.slice(0,100);}
function topicFrom(text:string,scope:MemoryScope,kind:MemoryKind,nodes:GraphNode[]){const anchor=nodes[0]?.canonicalName??keywords(text)[0]??"general";const concept=preferenceDimension(text);return `${scope.type}.${scope.id}.${kind}.${slug(anchor)}.${slug(concept)}`.slice(0,180);}
function slug(value:string){return value.toLowerCase().replace(/[^\p{L}\p{N}_.-]/gu,"-").replace(/-+/g,"-").replace(/^-|-$/g,"")||"general";}
