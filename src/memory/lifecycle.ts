import type { GraphStorePort, RecordStorePort, TopicCatalogPort, VectorIndexPort } from "./ports.js";
import type { AccessContext, ExtractionProposal, TopicDescriptor, WarmMemory } from "./types.js";

export interface LifecycleOptions { warmAfterMs?:number; hotTtlMs?:number; coldMinimumRecords?:number; minimumColdConfidence?:number }
export class MemoryLifecycle {
  constructor(private readonly records:RecordStorePort,private readonly vectors:VectorIndexPort|undefined,private readonly graph:GraphStorePort|undefined,private readonly topics:TopicCatalogPort,private readonly options:LifecycleOptions={}){}
  async integrate(access:AccessContext,proposal:ExtractionProposal){
    await this.graph?.upsertNodes(proposal.nodes); await this.graph?.upsertEdges(proposal.edges);
    const existing=await this.records.list(access.scopes,undefined,20_000); const accepted:WarmMemory[]=[];
    for(const candidate of proposal.records){
      const duplicate=existing.find((item)=>sameMemory(item,candidate));
      if(duplicate){accepted.push(mergeDuplicate(duplicate,candidate));continue;}
      const conflict=existing.find((item)=>conflicts(item,candidate));
      if(conflict){accepted.push({...conflict,status:"superseded",updatedAt:Date.now()},candidate.kind==="preference"?{...candidate,status:candidate.origin==="inferred"?"candidate":"active",supersedesId:conflict.id}:{...candidate,status:"active",supersedesId:conflict.id});continue;}
      accepted.push(candidate.kind==="preference"&&candidate.origin==="inferred"?{...candidate,status:"candidate"}:candidate);
    }
    const mergedTopics=mergeTopics(proposal.topics,accepted); await this.topics.upsertDescriptors(mergedTopics);
    return{records:accepted,topics:mergedTopics,nodes:proposal.nodes.length,edges:proposal.edges.length};
  }
  async promote(access:AccessContext){
    const now=Date.now(),warmAfter=this.options.warmAfterMs??0;const all=await this.records.list(access.scopes,undefined,50_000);const updates:WarmMemory[]=[];const expiredIds:string[]=[];
    for(const record of all){
      if(record.expiresAt&&record.expiresAt<=now){updates.push({...record,status:"deleted",updatedAt:now});expiredIds.push(record.id);continue;}
      if(record.tier==="hot"&&record.status==="active"&&now-record.createdAt>=warmAfter)updates.push({...record,tier:"warm",expiresAt:undefined,updatedAt:now});
      if(record.kind==="preference"&&record.status==="candidate"){const peers=all.filter((x)=>x.kind==="preference"&&x.id!==record.id&&sameMemory(x,record));if(peers.length)updates.push({...record,status:"active",tier:"warm",confidence:Math.max(record.confidence,0.8),updatedAt:now});}
    }
    if(updates.length)await this.records.upsertRecords(updates);if(expiredIds.length)await this.vectors?.remove(expiredIds);return{updated:updates.length,expired:expiredIds.length};
  }
  async topicCandidates(access:AccessContext){const topics=await this.topics.listDescriptors(access.scopes,["fact","preference","episode","procedure"],20_000);const all=await this.records.list(access.scopes,undefined,50_000);const minimum=this.options.coldMinimumRecords??2,confidence=this.options.minimumColdConfidence??0.7;return topics.filter((topic)=>all.filter((r)=>r.topicIds.includes(topic.topicId)&&r.tier==="warm"&&r.status==="active"&&r.confidence>=confidence).length>=minimum);}
}
function normalized(record:WarmMemory){return(record.kind==="preference"?`${record.dimension}:${record.value}`:`${record.kind}:${record.title}:${record.content}`).toLowerCase().replace(/\s+/g," ").trim();}
function sameMemory(a:WarmMemory,b:WarmMemory){return a.kind===b.kind&&a.scope.type===b.scope.type&&a.scope.id===b.scope.id&&normalized(a)===normalized(b);}
function conflicts(a:WarmMemory,b:WarmMemory){if(a.kind!==b.kind||a.scope.type!==b.scope.type||a.scope.id!==b.scope.id||a.status!=="active")return false;if(a.kind==="preference"&&b.kind==="preference")return a.dimension===b.dimension&&a.applicability===b.applicability&&a.value!==b.value;if(a.kind!=="preference"&&b.kind!=="preference")return a.kind==="fact"&&b.kind==="fact"&&a.title===b.title&&a.content!==b.content;return false;}
function mergeDuplicate(a:WarmMemory,b:WarmMemory):WarmMemory{const sourceRefs=[...a.sourceRefs,...b.sourceRefs.filter((ref)=>!a.sourceRefs.some((old)=>old.sourceType===ref.sourceType&&old.sourceId===ref.sourceId&&old.revision===ref.revision))];if(a.kind==="preference"&&b.kind==="preference")return{...a,tier:"warm",status:"active",strength:Math.min(1,a.strength+0.08),confidence:Math.min(1,Math.max(a.confidence,b.confidence)+0.05),sourceRefs,updatedAt:Date.now()};if(a.kind!=="preference"&&b.kind!=="preference")return{...a,tier:"warm",confidence:Math.min(1,Math.max(a.confidence,b.confidence)+0.05),importance:Math.max(a.importance,b.importance),sourceRefs,updatedAt:Date.now()};return b;}
function mergeTopics(topics:TopicDescriptor[],records:WarmMemory[]){return topics.map((topic)=>({...topic,entityIds:[...new Set([...topic.entityIds,...records.filter((r)=>r.topicIds.includes(topic.topicId)).flatMap((r)=>r.entityIds)])]}));}
